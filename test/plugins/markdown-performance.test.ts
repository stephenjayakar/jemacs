import { expect, test } from "bun:test"
import { install } from "../../plugins/markdown"
import { registerTreeSitterGrammars } from "../../plugins/tree-sitter-grammars"
import { makeEditor } from "./helper"

registerTreeSitterGrammars()

test("markdown viewport font-lock stays independent of large document size", () => {
  const paragraph = [
    "## Heading",
    "Text with **strong**, *emphasis*, [a link](https://example.com), and `code`.",
    "",
  ].join("\n")
  /** Best of 5 timings of a 200-line viewport in the middle of the document. */
  const viewportMs = (paragraphs: number) => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch(`large-${paragraphs}.md`, paragraph.repeat(paragraphs), "markdown")
    // Prime the document parse and structural caches, as opening the buffer does.
    editor.fontLock(buffer, { startLine: 0, endLine: 200, start: 0, end: buffer.lineStarts[200]! })
    let best = Infinity
    for (let run = 0; run < 5; run++) {
      // A fresh window each run, so no range-level cache answers it.
      const startLine = Math.floor(paragraphs * 1.5) + run * 30
      const endLine = startLine + 200
      const start = buffer.lineStarts[startLine]!
      const end = buffer.lineStarts[endLine]!
      const before = performance.now()
      const spans = editor.fontLock(buffer, { startLine, endLine, start, end })
      best = Math.min(best, performance.now() - before)
      expect(spans.length).toBeGreaterThan(0)
      expect(spans.every(span => span.end >= start && span.start <= end)).toBe(true)
    }
    return best
  }
  // This took well over a second when range highlighting still walked and
  // rescanned the whole ~900 KB document, so it grew with the document. Compare
  // against a 10x smaller one instead of a wall-clock budget, which failed on a
  // busy machine.
  const small = viewportMs(1_000)
  const large = viewportMs(10_000)
  expect(large / small).toBeLessThan(4)
}, 60_000) // priming a ~900 KB document is slow on a busy machine

test("range font-lock preserves absolute link and strikethrough offsets", () => {
  const editor = makeEditor()
  install(editor)
  const prefix = "outside\n".repeat(100)
  const target = "[link](https://example.com) and ~~gone~~\n"
  const buffer = editor.scratch("README.md", prefix + target, "gfm")
  const startLine = 100
  const start = prefix.length
  const end = buffer.text.length

  const spans = editor.fontLock(buffer, { startLine, endLine: 101, start, end })

  expect(spans.some(span =>
    span.start === start
    && span.end === start + "[link](https://example.com)".length
    && String(span.face) === "markdown-link",
  )).toBe(true)
  const gone = buffer.text.indexOf("gone")
  expect(spans.some(span =>
    span.start === gone
    && span.end === gone + 4
    && String(span.face) === "markdown-strikethrough",
  )).toBe(true)
})
