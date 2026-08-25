import { expect, test } from "bun:test"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { DOM_FRAME_LINE_HEIGHT_RATIO, DOM_FRAME_ROW_PX } from "../../src/display/dom-frame"
import { themedTextPlain } from "../../src/display/themed-text"
import { pageScrollLines } from "../../src/display/viewport"
import { resetFace } from "../../src/runtime/faces"
import { makeEditor } from "../plugins/helper"
import { install } from "../../plugins/markdown"

const guiCaps = { unit: "pixels" as const, mouse: true, clipboard: true, osc52: false, perFaceFonts: true }

test("GUI markdown scroll keeps cursor on screen below tall headings", async () => {
  const editor = makeEditor()
  install(editor)
  const lines = ["# Title"]
  for (let i = 0; i < 40; i++) lines.push(`line ${i}`)
  const buffer = editor.scratch("doc.md", lines.join("\n") + "\n", "markdown")
  buffer.point = buffer.text.length

  const model = buildDisplayModel(editor, {
    lastMessage: "",
    viewport: { rows: 30, cols: 80 },
    hostCapabilities: guiCaps,
  })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  expect(pane).not.toBeNull()
  // GUI hosts get a caret coordinate rather than a █ in the text; the row it
  // names still has to be inside the pane's budget and inside the body.
  const bodyRows = themedTextPlain(pane!.body).split("\n")
  const cursorRow = pane!.cursor?.row ?? -1
  expect(cursorRow).toBeGreaterThanOrEqual(0)
  expect(cursorRow).toBeLessThan(pane!.bodyLineBudget)
  expect(cursorRow).toBeLessThan(bodyRows.length)
})

test("GUI markdown body fills the pane without leaving a huge empty gap", () => {
  // Other suites' installStephenConfig leaks setFaceAttribute("default","height",140);
  // markdown no longer remaps default :height, so reset to get the 13px fallback.
  resetFace("default")
  const editor = makeEditor()
  install(editor)
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`)
  editor.scratch("doc.md", lines.join("\n") + "\n", "markdown")

  const rows = 30
  const budget = pageScrollLines(rows)
  const bodyCost = (13 * DOM_FRAME_LINE_HEIGHT_RATIO) / DOM_FRAME_ROW_PX
  const expectedLines = Math.floor(budget / bodyCost)

  const model = buildDisplayModel(editor, {
    lastMessage: "",
    viewport: { rows, cols: 80 },
    hostCapabilities: guiCaps,
  })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  const rendered = themedTextPlain(pane!.body).split("\n").length
  expect(rendered).toBeGreaterThanOrEqual(expectedLines - 1)
  expect(rendered).toBeLessThanOrEqual(expectedLines + 1)
  expect(rendered).toBeGreaterThan(budget / 2)
})
