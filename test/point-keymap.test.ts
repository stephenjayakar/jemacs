import { expect, test } from "bun:test"
import { Editor } from "../src/kernel/editor"
import { addPointKeymapSource } from "../src/kernel/extension-points"
import { Keymap } from "../src/kernel/keymap"
import { defineMode } from "../src/modes/mode"
import { installDefaultModes } from "../src/modes/default-modes"

test("point-sensitive keymap is consulted before major-mode lineage", () => {
  installDefaultModes()
  const modeMap = new Keymap("point-keymap-test-mode-map")
  modeMap.bind("x", "mode-command")
  defineMode({ name: "point-keymap-test-mode", parent: "text", keymap: modeMap })
  const localMap = new Keymap("point-local-test-map")
  localMap.bind("x", "local-command")
  const editor = new Editor()
  const buffer = editor.scratch("*point-keymap*", "abc", "point-keymap-test-mode")
  const dispose = addPointKeymapSource((candidate, point) => candidate === buffer && point === 1 ? localMap : null)
  try {
    buffer.point = 1
    expect(editor.keymaps.lookup("x")).toMatchObject({ status: "matched", command: "local-command", mapName: "point-local-test-map" })
    buffer.point = 0
    expect(editor.keymaps.lookup("x")).toMatchObject({ status: "matched", command: "mode-command", mapName: "point-keymap-test-mode-map" })
  } finally {
    dispose()
  }
})

