import { describe, expect, test } from "bun:test"
import { makeEditor } from "./helper"
import { displayRows, spans } from "../harness"
import {
  HL_LINE_FACE,
  install,
  WHITESPACE_LINE_FACE,
  WHITESPACE_TAB_FACE,
  WHITESPACE_TRAILING_FACE,
} from "../../plugins/whitespace"

describe("whitespace-mode", () => {
  test("display spans highlight trailing whitespace only while enabled", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*whitespace*", "alpha  \nbeta\n", "text")
    buffer.point = buffer.text.length

    expect(displayRows(editor)[0]).toContain("alpha  ")
    expect(spans(editor).some(span => span.face === WHITESPACE_TRAILING_FACE)).toBe(false)

    await editor.run("whitespace-mode")
    expect(spans(editor)).toContainEqual({ start: 5, end: 7, face: WHITESPACE_TRAILING_FACE })

    await editor.run("whitespace-mode")
    expect(spans(editor).some(span => span.face === WHITESPACE_TRAILING_FACE)).toBe(false)
  })

  test("global-whitespace-mode highlights every buffer", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*global-whitespace*", "one\t \n", "text")

    await editor.run("global-whitespace-mode")

    expect(editor.isMinorModeEnabled("global-whitespace-mode", buffer)).toBe(true)
    expect(spans(editor)).toContainEqual({ start: 3, end: 4, face: WHITESPACE_TAB_FACE })
    expect(spans(editor)).toContainEqual({ start: 3, end: 5, face: WHITESPACE_TRAILING_FACE })
  })

  test("marks text beyond fill-column", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*long-line*", "123456789\n", "text")
    buffer.locals.set("fill-column", 5)

    await editor.run("whitespace-mode")

    expect(spans(editor)).toContainEqual({ start: 5, end: 9, face: WHITESPACE_LINE_FACE })
  })
})

describe("hl-line-mode", () => {
  test("highlights current line text", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*hl-line*", "first\nsecond\n", "text")
    buffer.point = buffer.text.indexOf("second")

    await editor.run("hl-line-mode")

    expect(spans(editor)).toContainEqual({ start: 6, end: 12, face: HL_LINE_FACE })
  })
})
