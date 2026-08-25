import { expect, test } from "bun:test"
import { install } from "../../plugins/winner"
import { listWindowLeaves } from "../../src/kernel/window"
import { makeEditor } from "./helper"

test("winner-undo restores a single-window layout and winner-redo restores the split", async () => {
  const editor = makeEditor()
  install(editor)
  await editor.run("winner-mode")

  expect(editor.isMinorModeEnabled("winner-mode")).toBe(true)
  expect(editor.keymaps.lookup("C-c <left>")).toMatchObject({ status: "matched", command: "winner-undo" })
  expect(editor.keymaps.lookup("C-c <right>")).toMatchObject({ status: "matched", command: "winner-redo" })

  await editor.run("split-window-right")
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(2)

  await editor.run("winner-undo")
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(1)

  await editor.run("winner-redo")
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(2)
})
