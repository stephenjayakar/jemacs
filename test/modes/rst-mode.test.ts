import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { getMode, modeFeature, type TextSpan } from "../../src/modes/mode"
import { installRstMode, rstFontLock } from "../../src/modes/rst"

function expectSpan(text: string, spans: TextSpan[], needle: string, face: TextSpan["face"]): void {
  const start = text.indexOf(needle)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

function expectSpanAt(text: string, spans: TextSpan[], needle: string, start: number, face: TextSpan["face"]): void {
  expect(start).toBeGreaterThanOrEqual(0)
  expect(text.slice(start, start + needle.length)).toBe(needle)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

test("rst-mode registers a text-family mode with reStructuredText comments", () => {
  installRstMode()

  expect(getMode("rst-mode")?.parent).toBe("text")
  expect(getMode("rst-mode")?.commentStart).toBe("..")
  expect(modeFeature("rst-mode", "fontLock")).toBe(rstFontLock)
})

test("rst-mode font-lock highlights section titles and markup forms", () => {
  installRstMode()
  const text = [
    "Document Title",
    "==============",
    "",
    ".. note:: Pay attention",
    ".. _target-name: https://example.test",
    ":field: value",
    "Paragraph with ``literal`` and **strong** plus *emphasis*.",
    "Paragraph ending::",
    "  literal body",
    "Subsection",
    "----------",
    "Tiny",
    "~~~~",
  ].join("\n")
  const buffer = new BufferModel({ name: "guide.rst", text, mode: "rst-mode" })
  const spans = rstFontLock(buffer)
  const literalBlockMarker = text.indexOf("::", text.indexOf("Paragraph ending"))

  expectSpan(text, spans, "Document Title", "type")
  expectSpan(text, spans, "==============", "type")
  expectSpan(text, spans, ".. note::", "keyword")
  expectSpan(text, spans, ".. _target-name:", "constant")
  expectSpan(text, spans, ":field:", "constant")
  expectSpan(text, spans, "``literal``", "string")
  expectSpan(text, spans, "**strong**", "keyword")
  expectSpan(text, spans, "*emphasis*", "keyword")
  expectSpanAt(text, spans, "::", literalBlockMarker, "string")
  expectSpan(text, spans, "Subsection", "type")
  expectSpan(text, spans, "----------", "type")
  expectSpan(text, spans, "Tiny", "type")
  expectSpan(text, spans, "~~~~", "type")
})

test("rst-mode font-lock respects requested line ranges", () => {
  installRstMode()
  const text = [
    "Title",
    "=====",
    "",
    ".. warning:: ranged",
    "Paragraph with ``literal``.",
  ].join("\n")
  const buffer = new BufferModel({ name: "range.rst", text, mode: "rst-mode" })
  const spans = rstFontLock(buffer, { startLine: 3, endLine: 5, start: buffer.lineStarts[3]!, end: buffer.text.length })

  expect(spans.some(span => text.slice(span.start, span.end) === "Title")).toBe(false)
  expect(spans.some(span => text.slice(span.start, span.end) === "=====")).toBe(false)
  expectSpan(text, spans, ".. warning::", "keyword")
  expectSpan(text, spans, "``literal``", "string")
})
