import { expect, test } from "bun:test"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { FontMetricsTable, PRELOAD_CHARS, fontKey, parseFontKey } from "../../src/display/font-metrics"
import { wrapLinePx } from "../../src/display/pixel-wrap"
import { themedTextPlain } from "../../src/display/themed-text"
import { resetFace } from "../../src/runtime/faces"
import { makeEditor } from "../plugins/helper"
import { install } from "../../plugins/markdown"

/** Every glyph is 0.6 em wide, so row breaks are exact to compute in a test. */
class EmMetrics extends FontMetricsTable {
  override advance(ch: string, spec: Parameters<FontMetricsTable["advance"]>[1]): number {
    return ch === "\u200b" ? 0 : spec.px * 0.6
  }
  override averageWidth(spec: Parameters<FontMetricsTable["averageWidth"]>[0]): number {
    return spec.px * 0.6
  }
}

function guiCaps(metrics: FontMetricsTable) {
  return { unit: "pixels" as const, mouse: true, clipboard: true, osc52: false, perFaceFonts: true, fontMetrics: metrics }
}

const HEADING = "# A deliberately long level one heading that should wrap across the text column"

function markdownEditor(text: string) {
  resetFace("default")
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("doc.md", text, "markdown")
  buffer.point = 0
  return { editor, buffer }
}

test("wrapLinePx breaks at the last space that fits and keeps one glyph per row", () => {
  const line = "aaa bbb ccc"
  // "aaa bbb" (70px) fits in 75px; the break space hangs at the row end.
  expect(wrapLinePx(line, Array(line.length).fill(10), 75, true, 0)).toEqual([[0, 8], [8, 11]])
  expect(wrapLinePx(line, Array(line.length).fill(10), 55, true, 0)).toEqual([[0, 4], [4, 8], [8, 11]])
  expect(wrapLinePx("abc", [100, 100, 100], 50, false, 0)).toEqual([[0, 1], [1, 2], [2, 3]])
})

test("wrapLinePx starts a continuation row with the caret marker at a break", () => {
  const line = "ab\u200bcd"
  expect(wrapLinePx(line, [10, 10, 0, 10, 10], 25, false, 0)).toEqual([[0, 2], [2, 5]])
})

test("font keys round-trip and the table measures preloaded ASCII exactly", () => {
  const table = new FontMetricsTable()
  const spec = { family: "Inter", px: 17, weight: 600, italic: true }
  const key = fontKey(spec)
  expect(parseFontKey(key)).toEqual(spec)
  table.merge({ [key]: Object.fromEntries([...PRELOAD_CHARS].map(ch => [ch, 7])) }, false)
  expect(table.advance("x", spec)).toBe(7)
})

test("GUI markdown rows are pixel-wrapped so the host never wraps them again", () => {
  const { editor } = markdownEditor(`${HEADING}\n\nbody\n`)
  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 40, cols: 100 }, hostCapabilities: guiCaps(new EmMetrics()) })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  expect(pane?.textColumn).toBeDefined()
  const { leftPx, widthPx } = pane!.textColumn!
  expect(leftPx).toBeGreaterThanOrEqual(0)
  expect(leftPx + widthPx).toBeLessThanOrEqual(100 * 9)
  // The H1 is much wider than the column at its scaled size, so the kernel
  // emits it as several rows. No row carries centring spaces.
  const rows = themedTextPlain(pane!.body).split("\n")
  const headingRows = rows.slice(0, rows.findIndex(r => r.trim() === ""))
  expect(headingRows.length).toBeGreaterThan(1)
  for (const row of rows) expect(row.startsWith(" ")).toBe(false)
})

test("C-n in a GUI markdown buffer walks the pixel rows of a wrapped heading", async () => {
  const { editor, buffer } = markdownEditor(`${HEADING}\n\nbody\n`)
  const caps = guiCaps(new EmMetrics())
  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 40, cols: 100 }, hostCapabilities: caps })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  const bodyRows = themedTextPlain(pane!.body).split("\n")
  const headingRows = bodyRows.slice(0, bodyRows.findIndex(r => r.trim() === "")).length
  expect(editor.lastHostCapabilities?.fontMetrics).toBe(caps.fontMetrics)

  // One C-n per heading row stays on line 1 until the last row is left.
  for (let i = 1; i < headingRows; i++) {
    await editor.run("next-line")
    expect(buffer.lineAt(buffer.point)).toBe(0)
  }
  await editor.run("next-line")
  expect(buffer.lineAt(buffer.point)).toBe(1)
  // And back up again, row by row.
  for (let i = 0; i < headingRows; i++) await editor.run("previous-line")
  expect(buffer.lineAt(buffer.point)).toBe(0)
  expect(buffer.point).toBeLessThan(10)
})

test("a zoomed text column grows with the text, then keeps a side margin", () => {
  const { editor } = markdownEditor("body\n")
  const metrics = new EmMetrics()
  const pane = (scale: number) => {
    editor.activeBuffer.locals.set("text-scale-mode-amount", scale)
    const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 40, cols: 240 }, hostCapabilities: guiCaps(metrics) })
    return model.windows.kind === "leaf" ? model.windows.pane.textColumn! : null
  }
  const base = pane(0)!
  const zoomed = pane(2)!
  const huge = pane(8)!
  const contentPx = 240 * 9 - 24
  expect(zoomed.widthPx).toBeGreaterThan(base.widthPx)
  // Past the window width the column stops growing and keeps space either side.
  expect(huge.leftPx).toBeGreaterThan(0)
  expect(huge.leftPx * 2 + huge.widthPx).toBeLessThanOrEqual(contentPx + 1)
})

test("without adjust-for-text-scale a zoomed text column keeps its px width", () => {
  const { editor } = markdownEditor("body\n")
  editor.activeBuffer.locals.set("markdown-visual-fill-column-adjust-for-text-scale", false)
  const metrics = new EmMetrics()
  const pane = (scale: number) => {
    editor.activeBuffer.locals.set("text-scale-mode-amount", scale)
    const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 40, cols: 240 }, hostCapabilities: guiCaps(metrics) })
    return model.windows.kind === "leaf" ? model.windows.pane.textColumn! : null
  }
  const base = pane(0)!
  expect(pane(2)!.widthPx).toBe(base.widthPx)
  expect(pane(-2)!.widthPx).toBe(base.widthPx)
})
