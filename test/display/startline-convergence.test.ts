/**
 * `buildDisplayModel` must be idempotent.
 *
 * It calls `editor.syncSelectedWindowViewport`, which writes a corrected `startLine`
 * back into the window layout. If that write does not converge -- if rendering frame N
 * produces a different `startLine` than frame N+1 for the same buffer state -- then
 * every present schedules another present, and the pane oscillates between two scroll
 * positions. That is a flicker with no user input at all.
 *
 * The bottom of the buffer is where this is most likely: the correction is clamped by
 * the line budget there, so an off-by-one between the value used for rendering and the
 * value persisted can ping-pong forever.
 */
import { describe, expect, test } from "bun:test"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { makeEditor } from "../plugins/helper"
import type { Editor } from "../../src/kernel/editor"

const NL = String.fromCharCode(10)

const CAPS_GUI = {
  unit: "pixels" as const,
  mouse: true,
  clipboard: true,
  osc52: false,
  richTables: true,
  webSurfaces: true,
  perFaceFonts: true,
}

function startLineOf(editor: Editor): number {
  return editor.selectedWindowLeaf()?.startLine ?? 0
}

/** Render repeatedly and collect the persisted startLine after each frame. */
function startLineSeries(editor: Editor, frames: number, rows: number): number[] {
  const seen: number[] = []
  for (let i = 0; i < frames; i++) {
    buildDisplayModel(editor, {
      viewport: { rows, cols: 100 },
      hostCapabilities: CAPS_GUI,
    })
    seen.push(startLineOf(editor))
  }
  return seen
}

function bufferOfLines(editor: Editor, count: number, width = 40) {
  const text = Array.from({ length: count }, (_, i) => `line ${i} ` + "x".repeat(width)).join(NL)
  const buffer = editor.scratch("*scroll*", text, "text")
  editor.switchToBuffer(buffer.id)
  return buffer
}

describe("startLine converges across frames", () => {
  test("point at end of buffer settles to one startLine", () => {
    const editor = makeEditor()
    const buffer = bufferOfLines(editor, 300)
    buffer.point = buffer.text.length

    const series = startLineSeries(editor, 8, 24)
    // Every frame after the first correction must agree.
    const settled = series.slice(1)
    expect(new Set(settled).size).toBe(1)
  })

  test("point on the very last line settles", () => {
    const editor = makeEditor()
    const buffer = bufferOfLines(editor, 120)
    buffer.point = buffer.text.lastIndexOf(NL) + 1

    const series = startLineSeries(editor, 8, 24)
    expect(new Set(series.slice(1)).size).toBe(1)
  })

  test("settles for a range of viewport heights", () => {
    const unstable: Array<{ rows: number; series: number[] }> = []
    for (const rows of [10, 13, 17, 20, 24, 31, 40, 51]) {
      const editor = makeEditor()
      const buffer = bufferOfLines(editor, 200)
      buffer.point = buffer.text.length
      const series = startLineSeries(editor, 6, rows)
      if (new Set(series.slice(1)).size !== 1) unstable.push({ rows, series })
    }
    expect(unstable).toEqual([])
  })

  test("settles with wrapped long lines at the bottom", () => {
    const editor = makeEditor()
    // Lines far wider than the viewport, so visual-row weighting is in play.
    const text = Array.from({ length: 80 }, (_, i) => `line ${i} ` + "y".repeat(300)).join(NL)
    const buffer = editor.scratch("*wrapped*", text, "text")
    editor.switchToBuffer(buffer.id)
    buffer.locals.set("word-wrap", true)
    buffer.point = buffer.text.length

    const series = startLineSeries(editor, 8, 24)
    expect(new Set(series.slice(1)).size).toBe(1)
  })

  test("settles immediately after scrolling to the end", () => {
    const editor = makeEditor()
    const buffer = bufferOfLines(editor, 500)
    buffer.point = buffer.text.length
    // First render performs the correction.
    startLineSeries(editor, 1, 24)
    const afterFirst = startLineOf(editor)
    // Subsequent renders must not move it again.
    const series = startLineSeries(editor, 5, 24)
    expect(series).toEqual([afterFirst, afterFirst, afterFirst, afterFirst, afterFirst])
  })
})
