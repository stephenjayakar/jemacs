import { describe, expect, test } from "bun:test"
import { spans } from "../harness"
import { makeEditor } from "./helper"
import { install, RECTANGLE_PREVIEW_FACE, rectangleRegionSpans } from "../../plugins/rectangle-mark"

const TEXT = "alpha one\nbeta two\ngamma three\n"

describe("rectangle-mark-mode", () => {
  test("toggling sets mark and highlights a per-line rectangle", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*rect*", TEXT, "text")
    buffer.point = 2 // line 1, col 2

    await editor.run("rectangle-mark-mode")
    expect(editor.isMinorModeEnabled("rectangle-mark-mode", buffer)).toBe(true)
    expect(buffer.mark).toBe(2)

    buffer.point = TEXT.indexOf("gamma") + 7 // line 3, col 7

    const rect = spans(editor).filter(span => span.face === RECTANGLE_PREVIEW_FACE)
    expect(rect).toEqual([
      { start: 2, end: 7, face: RECTANGLE_PREVIEW_FACE },
      { start: 12, end: 17, face: RECTANGLE_PREVIEW_FACE },
      { start: 21, end: 26, face: RECTANGLE_PREVIEW_FACE },
    ])
    // The linear region must not render alongside the rectangle.
    expect(spans(editor).some(span => span.face === "region")).toBe(false)
  })

  test("rectangle spans clip to short lines", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*rect-short*", "longer line\nab\nlonger line\n", "text")
    buffer.point = 4

    await editor.run("rectangle-mark-mode")
    buffer.point = "longer line\nab\n".length + 8

    const rect = rectangleRegionSpans(buffer)
    expect(rect).toEqual([
      { start: 4, end: 8, face: RECTANGLE_PREVIEW_FACE },
      // "ab" only reaches col 2; nothing to highlight past its end.
      { start: 15 + 4, end: 15 + 8, face: RECTANGLE_PREVIEW_FACE },
    ])
  })

  test("kill-rectangle kills the region-rectangle and ends the mode", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*rect-kill*", TEXT, "text")
    buffer.point = 0

    await editor.run("rectangle-mark-mode")
    buffer.point = TEXT.indexOf("gamma") + 5 // col 5 on line 3

    await editor.run("kill-rectangle")
    expect(buffer.text).toBe(" one\ntwo\n three\n")
    expect(editor.isMinorModeEnabled("rectangle-mark-mode", buffer)).toBe(false)
  })

  test("keyboard-quit cancels the rectangle", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*rect-quit*", TEXT, "text")

    await editor.run("rectangle-mark-mode")
    expect(editor.isMinorModeEnabled("rectangle-mark-mode", buffer)).toBe(true)

    await editor.run("keyboard-quit")
    expect(editor.isMinorModeEnabled("rectangle-mark-mode", buffer)).toBe(false)
    expect(rectangleRegionSpans(buffer)).toEqual([])
  })

  test("rectangle-exchange-point-and-mark swaps the corners", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*rect-swap*", TEXT, "text")
    buffer.point = 2

    await editor.run("rectangle-mark-mode")
    buffer.point = 14

    await editor.run("rectangle-exchange-point-and-mark")
    expect(buffer.point).toBe(2)
    expect(buffer.mark).toBe(14)
  })
})
