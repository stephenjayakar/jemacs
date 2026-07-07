import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { Editor } from "../../src/kernel/editor"
import { getMode, modeFeature, type TextSpan } from "../../src/modes/mode"
import { installOutlineCommands, installOutlineMode, outlineFontLock, outlineNextVisibleHeading, outlinePreviousVisibleHeading } from "../../src/modes/outline"

function expectSpan(text: string, spans: TextSpan[], needle: string, face: TextSpan["face"]): void {
  const start = text.indexOf(needle)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

test("outline-mode registers a text-family mode and GNU outline navigation bindings", () => {
  installOutlineMode()

  const mode = getMode("outline-mode")
  expect(mode?.parent).toBe("text")
  expect(mode?.keymap?.get("C-c C-n")).toBe("outline-next-visible-heading")
  expect(mode?.keymap?.get("C-c C-p")).toBe("outline-previous-visible-heading")
  expect(modeFeature("outline-mode", "fontLock")).toBe(outlineFontLock)
})

test("outline-mode font-lock highlights star headings by level", () => {
  installOutlineMode()
  const text = [
    "* Top",
    "body",
    "** Child",
    "*** Grandchild",
    "plain *not a heading*",
  ].join("\n")
  const buffer = new BufferModel({ name: "outline.txt", text, mode: "outline-mode" })
  const spans = outlineFontLock(buffer)

  expectSpan(text, spans, "* Top", "keyword")
  expectSpan(text, spans, "** Child", "function")
  expectSpan(text, spans, "*** Grandchild", "type")
  expect(spans.some(span => text.slice(span.start, span.end) === "plain *not a heading*")).toBe(false)

  const ranged = outlineFontLock(buffer, { startLine: 2, endLine: 4, start: buffer.lineStarts[2]!, end: buffer.lineStarts[4]! })
  expect(ranged.some(span => text.slice(span.start, span.end) === "* Top")).toBe(false)
  expectSpan(text, ranged, "** Child", "function")
  expectSpan(text, ranged, "*** Grandchild", "type")
})

test("outline navigation helpers move between heading lines", () => {
  const text = [
    "* Top",
    "body",
    "** Child",
    "more",
    "* Next",
  ].join("\n")
  const buffer = new BufferModel({ name: "outline.txt", text, mode: "outline-mode" })
  buffer.point = text.indexOf("body")

  expect(outlineNextVisibleHeading(buffer)).toBe(true)
  expect(buffer.point).toBe(text.indexOf("** Child"))
  expect(outlineNextVisibleHeading(buffer)).toBe(true)
  expect(buffer.point).toBe(text.indexOf("* Next"))
  expect(outlineNextVisibleHeading(buffer)).toBe(false)
  expect(buffer.point).toBe(text.indexOf("* Next"))

  expect(outlinePreviousVisibleHeading(buffer)).toBe(true)
  expect(buffer.point).toBe(text.indexOf("** Child"))
  expect(outlinePreviousVisibleHeading(buffer)).toBe(true)
  expect(buffer.point).toBe(text.indexOf("* Top"))
})

test("outline commands install into the editor command registry", async () => {
  installOutlineMode()
  const editor = new Editor()
  installOutlineCommands(editor)
  const text = "* Top\nbody\n** Child\n"
  const buffer = editor.scratch("*outline*", text, "outline-mode")
  buffer.point = text.indexOf("body")

  expect(editor.commands.get("outline-next-visible-heading")).toBeDefined()
  expect(editor.commands.get("outline-previous-visible-heading")).toBeDefined()

  await editor.run("outline-next-visible-heading")
  expect(buffer.point).toBe(text.indexOf("** Child"))
  await editor.run("outline-previous-visible-heading")
  expect(buffer.point).toBe(text.indexOf("* Top"))
})
