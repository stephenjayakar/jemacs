/**
 * Clicks are reported as *physical* rows of the rendered body, but the buffer is
 * indexed in *logical* lines. When a line is longer than the window it renders
 * as several rows, so the two coordinate spaces diverge: without a row map,
 * `pointFromWindowClick` reads row N as "startLine + N logical lines" and every
 * click below a wrapped line lands too far down the buffer -- one line of drift
 * per continuation row above it.
 *
 * `clickState.wrappedRows` closes that gap. It also carries each row's character
 * range, so a click inside a continuation row resolves to the right column
 * rather than restarting at the beginning of the logical line.
 */
import { describe, expect, test } from "bun:test"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { pointFromWindowClick } from "../../src/display/click-to-point"
import { findPaneInModel } from "../../src/display/find-pane"
import { makeEditor } from "../plugins/helper"
import type { Editor } from "../../src/kernel/editor"
import type { HostCapabilities } from "../../src/display/protocol"

const NL = String.fromCharCode(10)
const GUI: HostCapabilities = {
  unit: "pixels", mouse: true, clipboard: true, osc52: false, perFaceFonts: true,
}
const LONG = "word ".repeat(60).trim()

function render(editor: Editor, cols = 40) {
  const model = buildDisplayModel(editor, { viewport: { rows: 30, cols }, hostCapabilities: GUI })
  const pane = findPaneInModel(model.windows, editor.selectedWindowId)!
  const rows = pane.body.chunks.map(c => c.text).join("").split(NL)
  return { pane, rows }
}

function setup(text: string, lineNumbers = false) {
  const editor = makeEditor()
  const buffer = editor.scratch("wrap.txt", text, "text")
  editor.switchToBuffer(buffer.id)
  buffer.point = 0
  if (lineNumbers) editor.showLineNumbers = () => true
  return { editor, buffer }
}

describe("clicking a hard-wrapped pane", () => {
  test("a click below a wrapped line hits that line, not one further down", () => {
    const text = ["first line", LONG, "third line", "fourth"].join(NL)
    const { editor, buffer } = setup(text)
    const { pane, rows } = render(editor)

    // The long line occupies many physical rows, so the body is taller than the
    // buffer has lines -- this is exactly the condition the bug needed.
    expect(rows.length).toBeGreaterThan(text.split(NL).length)

    const row = rows.findIndex(r => r.includes("third line"))
    expect(row).toBeGreaterThan(2)
    const point = pointFromWindowClick(
      buffer.text, pane.clickState, row, pane.clickState.gutterPrefixLen, pane.bodyLineBudget,
    )
    expect(point).toBe(text.indexOf("third line"))
  })

  test("a click inside a continuation row resolves to that row's column", () => {
    const text = ["first line", LONG, "last"].join(NL)
    const { editor, buffer } = setup(text)
    const { pane } = render(editor)

    // Row 2 is the *second* physical row of the long line. Its characters start
    // partway into the logical line, which the naive mapping ignored entirely.
    const second = pane.clickState.wrappedRows![2]!
    expect(second.line).toBe(1)
    expect(second.start).toBeGreaterThan(0)

    const col = 4
    const point = pointFromWindowClick(
      buffer.text, pane.clickState, 2, pane.clickState.gutterPrefixLen + col, pane.bodyLineBudget,
    )
    expect(point).toBe(text.indexOf(LONG) + second.start + col)
  })

  test("the line-number gutter is discounted from every row, continuations included", () => {
    const text = ["alpha", LONG, "omega"].join(NL)
    const { editor, buffer } = setup(text, true)
    const { pane, rows } = render(editor)
    const gutter = pane.clickState.gutterPrefixLen
    expect(gutter).toBeGreaterThan(0)

    // Column 0 of a numbered row is the first buffer character on that row, not
    // the first digit of the line number.
    expect(pointFromWindowClick(buffer.text, pane.clickState, 0, gutter, pane.bodyLineBudget))
      .toBe(text.indexOf("alpha"))

    const omega = rows.findIndex(r => r.includes("omega"))
    expect(pointFromWindowClick(buffer.text, pane.clickState, omega, gutter, pane.bodyLineBudget))
      .toBe(text.indexOf("omega"))
  })

  test("rows still map correctly when the pane is scrolled", () => {
    const lines = [...Array.from({ length: 40 }, (_, i) => `line ${i}`), LONG, "tail marker"]
    const text = lines.join(NL)
    const { editor, buffer } = setup(text)
    buffer.point = text.indexOf("tail marker")
    const { pane, rows } = render(editor)

    expect(pane.clickState.startLine).toBeGreaterThan(0)
    const row = rows.findIndex(r => r.includes("tail marker"))
    expect(row).toBeGreaterThanOrEqual(0)
    const point = pointFromWindowClick(
      buffer.text, pane.clickState, row, pane.clickState.gutterPrefixLen, pane.bodyLineBudget,
    )
    expect(point).toBe(text.indexOf("tail marker"))
  })

  test("clicking past the end of a row clamps to that row, not the next one", () => {
    const text = ["short", LONG, "end"].join(NL)
    const { editor, buffer } = setup(text)
    const { pane } = render(editor)

    const point = pointFromWindowClick(
      buffer.text, pane.clickState, 0, pane.clickState.gutterPrefixLen + 500, pane.bodyLineBudget,
    )
    expect(point).toBe("short".length)
  })
})
