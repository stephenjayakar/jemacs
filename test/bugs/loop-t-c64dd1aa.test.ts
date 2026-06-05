import { expect, test, spyOn } from "bun:test"
import Parser from "tree-sitter"
import { BufferModel } from "../../src/kernel/buffer"
import { treeSitterFontLock } from "../../src/modes/tree-sitter"

// t-c64dd1aa: treeSitterFontLock called parser.parse(buffer.text) with no oldTree, so
// every cache-missing render did a full parse (10-30ms on a 5k-line TS file). The
// per-buffer Tree is now retained, edited via tree.edit() with a prefix/suffix diff,
// and passed back to parser.parse() so tree-sitter reuses the unchanged subtrees.
test("tree-sitter: second fontLock after an edit reuses the old tree", () => {
  const buf = new BufferModel({ name: "a.ts", text: "const a = 1\nconst b = 2\n", mode: "typescript" })
  treeSitterFontLock("typescript", buf)

  const parse = spyOn(Parser.prototype, "parse")
  try {
    buf.point = buf.text.length
    buf.insert("const c = 3\n")
    const spans = treeSitterFontLock("typescript", buf)

    // Incremental: parse() received the previous tree as its second arg.
    expect(parse).toHaveBeenCalled()
    const oldTree = parse.mock.calls.at(-1)![1]
    expect(oldTree).toBeTruthy()
    expect((oldTree as Parser.Tree).rootNode).toBeDefined()

    // Correctness preserved: all three `const` tokens are still keyword-faced.
    const kw = spans.filter(s => s.face === "keyword" && buf.text.slice(s.start, s.end) === "const")
    expect(kw.map(s => s.start)).toEqual([0, 12, 24])
  } finally {
    parse.mockRestore()
  }
})

// t-c64dd1aa: unchanged text must not reparse at all — the cached tree is returned as-is.
test("tree-sitter: unchanged buffer skips reparse entirely", () => {
  const buf = new BufferModel({ name: "b.ts", text: "function f() { return 1 }\n", mode: "typescript" })
  treeSitterFontLock("typescript", buf)
  const parse = spyOn(Parser.prototype, "parse")
  try {
    treeSitterFontLock("typescript", buf)
    expect(parse).not.toHaveBeenCalled()
  } finally {
    parse.mockRestore()
  }
})

// t-d5cd3045 (merged): the overlap dedup in highlightWithQuery was O(captures²) —
// every candidate scanned every chosen span. Now resolved by a per-priority-tier
// merge, O(n log n). 3k one-line statements → ~10⁴ captures; the old path was ~10⁸
// comparisons and took seconds.
test("tree-sitter: highlight dedup is sub-quadratic on thousands of captures", () => {
  const src = Array.from({ length: 5000 }, (_, i) => `const v${i} = ${i}`).join("\n") + "\n"
  const buf = new BufferModel({ name: "big.ts", text: src, mode: "typescript" })
  treeSitterFontLock("typescript", buf) // warm: grammar load + first parse
  const t0 = performance.now()
  const spans = treeSitterFontLock("typescript", buf)
  const ms = performance.now() - t0
  // 5000 `const` keywords + 5000 numbers must all surface.
  expect(spans.filter(s => s.face === "keyword").length).toBeGreaterThanOrEqual(5000)
  expect(spans.filter(s => s.face === "number").length).toBe(5000)
  // Old path (full reparse + O(captures²) dedup) took ~480ms here; new path
  // (cached tree + tier-merge dedup) is ~60ms.
  expect(ms).toBeLessThan(250)
})

// Regression guard: a mid-buffer multi-line replace still yields correct spans
// (exercises the oldEndPosition computed from the removed slice, not buffer.lineAt).
test("tree-sitter: incremental parse handles multi-line replace", () => {
  const buf = new BufferModel({
    name: "c.ts",
    text: "const a = 1\nlet x = 0\nlet y = 0\nconst b = 2\n",
    mode: "typescript",
  })
  treeSitterFontLock("typescript", buf)
  // Replace the two middle `let` lines with one `var` line.
  buf.replaceRange(12, 32, "var z = 9\n")
  const spans = treeSitterFontLock("typescript", buf)
  const kws = spans
    .filter(s => s.face === "keyword" && /\w/.test(buf.text[s.start]!))
    .map(s => buf.text.slice(s.start, s.end))
  expect(kws).toEqual(["const", "var", "const"])
  // And matches a from-scratch parse of the same text.
  const fresh = new BufferModel({ name: "c2.ts", text: buf.text, mode: "typescript" })
  expect(treeSitterFontLock("typescript", fresh)).toEqual(spans)
})
