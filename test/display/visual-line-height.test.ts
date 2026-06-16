import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { faceRemapAddRelative } from "../../src/runtime/faces"
import { defineTheme } from "../../src/display/theme"
import { DOM_FRAME_LINE_HEIGHT_RATIO, DOM_FRAME_ROW_PX } from "../../src/display/dom-frame"
import { wrapRowsForContent } from "../../src/display/display-wrap"
import {
  computeLineVisualRows,
  computeWrappedLineRows,
  syncViewportStartLine,
  visibleLineCountForBudget,
  visualRowLineRange,
} from "../../src/display/visual-line-height"
import type { TextSpan } from "../../src/modes/mode"

const theme = defineTheme("test", {
  default: { height: 200 },
})

test("computeLineVisualRows gives body lines proportional cost, not double-counted", () => {
  const text = "# Big\nbody\n"
  const buffer = new BufferModel({ name: "doc.md", mode: "markdown", text })
  faceRemapAddRelative(buffer, "default", { height: 200 })
  faceRemapAddRelative(buffer, "markdown-header-face-1", { heightScale: 2 })
  const spans: TextSpan[] = [{ start: 0, end: 5, face: "markdown-header-face-1" as TextSpan["face"] }]
  const rows = computeLineVisualRows(text, spans, theme, buffer)
  const bodyCost = (20 * DOM_FRAME_LINE_HEIGHT_RATIO) / DOM_FRAME_ROW_PX
  expect(rows[1]).toBeCloseTo(bodyCost, 5)
  expect(rows[0]!).toBeGreaterThan(rows[1]!)
  expect(rows[0]!).toBeCloseTo(bodyCost * 2, 5)
})

test("visibleLineCountForBudget fills pane for uniform markdown body text", () => {
  const budget = 26
  const bodyCost = (20 * DOM_FRAME_LINE_HEIGHT_RATIO) / DOM_FRAME_ROW_PX
  const visualRows = Array.from({ length: 40 }, () => bodyCost)
  expect(visibleLineCountForBudget(0, budget, visualRows.length, visualRows)).toBe(Math.floor(budget / bodyCost))
})

test("syncViewportStartLine scrolls earlier when cursor line is visually tall", () => {
  const rows = [3, 1, 1, 1, 1]
  expect(syncViewportStartLine(0, 0, 4, rows)).toBe(0)
  expect(syncViewportStartLine(0, 4, 4, rows)).toBe(1)
})

test("visibleLineCountForBudget fits fewer logical lines when headings are tall", () => {
  const rows = [3, 1, 1, 1, 1, 1]
  expect(visibleLineCountForBudget(0, 5, rows.length, rows)).toBe(3)
})

test("computeLineVisualRows multiplies cost when a line hard-wraps", () => {
  const text = "short\n" + "X".repeat(200) + "\n"
  const theme = defineTheme("wrap-test", { default: { height: 200 } })
  const bodyCost = (20 * DOM_FRAME_LINE_HEIGHT_RATIO) / DOM_FRAME_ROW_PX
  const rows = computeLineVisualRows(text, [], theme, undefined, 1, {
    wrapCols: 80,
    gutterPrefixLen: 0,
  })
  expect(rows[0]).toBeCloseTo(bodyCost, 5)
  expect(rows[1]!).toBeGreaterThan(bodyCost * 2)
})

test("computeLineVisualRows can limit work to a sparse line range", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
  const rows = computeLineVisualRows(text, [], theme, undefined, 1, {
    fromLine: 40,
    toLine: 42,
  })
  expect(rows.length).toBe(100)
  expect(rows[39]).toBeUndefined()
  expect(rows[40]).toBeDefined()
  expect(rows[42]).toBeDefined()
  expect(rows[43]).toBeUndefined()
  expect(visibleLineCountForBudget(39, 4, rows.length, rows)).toBe(3)
})

test("visualRowLineRange bounds GUI visual row work around viewport and cursor", () => {
  expect(visualRowLineRange(100, 105, 25, 1000)).toEqual({ fromLine: 75, toLine: 205 })
  expect(visualRowLineRange(0, 999, 25, 1000)).toEqual({ fromLine: 0, toLine: 999 })
})

test("wrapRowsForContent counts continuation rows", () => {
  expect(wrapRowsForContent(10, 80, 0)).toBe(1)
  expect(wrapRowsForContent(200, 80, 0)).toBe(3)
})

test("computeWrappedLineRows counts terminal wrap rows without font metrics", () => {
  const rows = computeWrappedLineRows(["short", "X".repeat(200)], {
    wrapCols: 40,
    gutterPrefixLen: 0,
  })
  expect(rows![0]).toBe(1)
  expect(rows![1]).toBe(5)
})

test("wrapRowsForContent honors word-wrap boundaries", () => {
  expect(wrapRowsForContent("alpha beta gamma delta", 12, 0, true)).toBe(2)
  expect(wrapRowsForContent("alpha beta gamma delta", 12, 0, false)).toBe(2)
})
