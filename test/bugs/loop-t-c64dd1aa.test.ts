import { expect, test, spyOn } from "bun:test"
import Parser from "tree-sitter"
import { BufferModel } from "../../src/kernel/buffer"
import { resolveCaptureOverlaps, treeSitterFontLock } from "../../src/modes/tree-sitter"
import { registerTreeSitterGrammars } from "../../plugins/tree-sitter-grammars"

registerTreeSitterGrammars()

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
test("tree-sitter: thousands of captures all surface", () => {
  const src = Array.from({ length: 5000 }, (_, i) => `const v${i} = ${i}`).join("\n") + "\n"
  const buf = new BufferModel({ name: "big.ts", text: src, mode: "typescript" })
  const spans = treeSitterFontLock("typescript", buf)
  // 5000 `const` keywords + 5000 numbers must all surface.
  expect(spans.filter(s => s.face === "keyword").length).toBeGreaterThanOrEqual(5000)
  expect(spans.filter(s => s.face === "number").length).toBe(5000)
})

// Time the dedup alone, by growth rate rather than a wall-clock budget. The
// native `query.captures()` is itself super-linear and swings with JIT warm-up
// and CPU load, so timing all of treeSitterFontLock was flaky. Quadrupling the
// captures costs ~4.5x on the merge path and ~16x on the quadratic one.
test("tree-sitter: highlight dedup is sub-quadratic on thousands of captures", () => {
  // Per statement, like `const vN = N`: a keyword, a number, and a
  // lower-priority variable capture overlapping the whole statement.
  const captures = (statements: number) => Array.from({ length: statements }, (_, i) => {
    const at = i * 16
    return [
      { start: at, end: at + 5, face: "keyword" as const, priority: 3 },
      { start: at + 11, end: at + 15, face: "number" as const, priority: 3 },
      { start: at, end: at + 15, face: "variable" as const, priority: 1 },
    ]
  }).flat()
  const bestMs = (statements: number) => {
    let best = Infinity
    for (let run = 0; run < 5; run++) {
      const input = captures(statements)
      const t0 = performance.now()
      const spans = resolveCaptureOverlaps(input)
      best = Math.min(best, performance.now() - t0)
      expect(spans.length).toBe(statements * 2)
    }
    return best
  }
  bestMs(10_000) // JIT warm-up
  expect(bestMs(40_000) / bestMs(10_000)).toBeLessThan(8)
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
