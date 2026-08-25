import { expect, test } from "bun:test"
import { buildDisplayModel } from "../src/display/build-display-model"
import { pointFromWindowClick } from "../src/display/click-to-point"
import { findPaneInModel } from "../src/display/find-pane"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig } from "../src/config"
import { installDefaultModes } from "../src/modes/default-modes"

test("editor.clickWindow moves point and selects window", () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  const buffer = editor.scratch("click", "hello\nworld", "text")
  const windowId = editor.selectedWindowId
  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 24 } })
  const pane = findPaneInModel(model.windows, windowId)!
  const point = pointFromWindowClick(buffer.text, pane.clickState, 1, pane.clickState.gutterPrefixLen, pane.bodyLineBudget)
  editor.clickWindow(windowId, point)
  expect(editor.currentBuffer.point).toBeGreaterThan(5)
})

test("dragging from a click activates the mark and selects the swept text", () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  const buffer = editor.scratch("drag", "hello\nworld", "text")
  const windowId = editor.selectedWindowId

  editor.clickWindow(windowId, 2)
  expect(buffer.markActive).toBe(false)

  editor.clickWindow(windowId, 5, true)
  expect(buffer.mark).toBe(2)
  expect(buffer.markActive).toBe(true)
  expect(buffer.selectedText()).toBe("llo")

  // Sweeping further extends from the same anchor, not from the previous point.
  editor.clickWindow(windowId, 8, true)
  expect(buffer.mark).toBe(2)
  expect(buffer.selectedText()).toBe("llo\nwo")

  // A plain click clears the region again.
  editor.clickWindow(windowId, 1)
  expect(buffer.markActive).toBe(false)
})
