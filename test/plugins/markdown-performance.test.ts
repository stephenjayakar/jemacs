import { expect, test } from "bun:test"
import { install } from "../../plugins/markdown"
import { registerTreeSitterGrammars } from "../../plugins/tree-sitter-grammars"
import { makeEditor } from "./helper"

registerTreeSitterGrammars()

test("markdown viewport font-lock stays independent of large document size", () => {
  const editor = makeEditor()
  install(editor)
  const paragraph = [
    "## Heading",
    "Text with **strong**, *emphasis*, [a link](https://example.com), and `code`.",
    "",
  ].join("\n")
  const buffer = editor.scratch("large.md", paragraph.repeat(10_000), "markdown")

  // Prime the document parse and structural caches, as opening the buffer does.
  editor.fontLock(buffer, {
    startLine: 0,
    endLine: 200,
    start: 0,
    end: buffer.lineStarts[200]!,
  })

  const startLine = 10_000
  const endLine = startLine + 200
  const start = buffer.lineStarts[startLine]!
  const end = buffer.lineStarts[endLine]!
  const before = performance.now()
  const spans = editor.fontLock(buffer, { startLine, endLine, start, end })
  const elapsed = performance.now() - before

  expect(spans.length).toBeGreaterThan(0)
  expect(spans.every(span => span.end >= start && span.start <= end)).toBe(true)
  // This took well over a second when range highlighting still walked and
  // rescanned the whole ~900 KB document. Leave generous headroom for CI.
  expect(elapsed).toBeLessThan(500)
})

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

  expect(spans).toContainEqual({
    start,
    end: start + "[link](https://example.com)".length,
    face: "markdown-link",
  })
  const gone = buffer.text.indexOf("gone")
  expect(spans).toContainEqual({ start: gone, end: gone + 4, face: "markdown-strikethrough" })
})
