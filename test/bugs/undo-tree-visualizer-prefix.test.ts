import { expect, test } from "bun:test"
import { install } from "../../plugins/undo-tree"
import { makeEditor } from "../plugins/helper"
import { keySeq } from "../harness"

// GNU undo-tree: a numeric ARG is the repeat count for visualizer undo/redo.
test("C-u C-p in the undo-tree visualizer undoes four steps", async () => {
  const editor = makeEditor()
  install(editor)
  const parent = editor.scratch("undo.txt", "", "text")
  for (const ch of "ABCDE") { parent.point = parent.text.length; parent.insert(ch) }
  const steps = parent.undoTreeSnapshot().current.id
  expect(steps).toBe(5)
  await editor.run("undo-tree-visualize")
  await keySeq(editor, "C-u", "C-p")
  expect(parent.undoTreeSnapshot().current.id).toBe(steps - 4)
  await keySeq(editor, "C-u", "2", "C-n")
  expect(parent.undoTreeSnapshot().current.id).toBe(steps - 2)
})
