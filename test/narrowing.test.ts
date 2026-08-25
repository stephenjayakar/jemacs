import { expect, test } from "bun:test"
import { BufferModel, withSavedRestriction } from "../src/kernel/buffer"
import type { Editor } from "../src/kernel/editor"
import { buildDisplayModel } from "../src/display/build-display-model"
import type { DisplayModel, WindowDisplayNode } from "../src/display/protocol"
import { themedTextPlain } from "../src/display/themed-text"
import { makeEditor } from "./plugins/helper"

const VIEWPORT = { rows: 24, cols: 80 }

test("narrow clamps point and hides text from the display model; widen restores it", async () => {
  const editor = makeEditor()
  const buffer = editor.currentBuffer
  buffer.setText("before\nvisible\noutside\n", false)
  const start = buffer.text.indexOf("visible")
  const end = start + "visible".length
  buffer.point = 0

  buffer.narrowToRegion(start, end)

  expect(buffer.isNarrowed).toBe(true)
  expect(buffer.point).toBe(start)
  expect(buffer.text).toContain("outside")

  buffer.point = end
  expect(selectedBody(editor)).toContain("visible")
  expect(selectedBody(editor)).not.toContain("before")
  expect(selectedBody(editor)).not.toContain("outside")

  expect(editor.keymap.get("C-x n n")).toBe("narrow-to-region")
  expect(editor.keymap.get("C-x n w")).toBe("widen")
  expect(editor.keymap.get("C-x n d")).toBe("narrow-to-defun")

  await editor.run("widen")

  expect(buffer.isNarrowed).toBe(false)
  expect(selectedBody(editor)).toContain("before")
  expect(selectedBody(editor)).toContain("outside")
})

test("narrow-to-region command uses point and mark", async () => {
  const editor = makeEditor()
  const buffer = editor.currentBuffer
  buffer.setText("alpha\nbeta\ngamma\n", false)
  buffer.point = buffer.text.indexOf("beta")
  buffer.setMark()
  const mark = buffer.mark!
  buffer.point = mark + "beta".length

  await editor.run("narrow-to-region")

  expect(buffer.restriction).toEqual({ start: buffer.text.indexOf("beta"), end: buffer.text.indexOf("beta") + "beta".length })
  expect(selectedBody(editor)).toContain("beta")
  expect(selectedBody(editor)).not.toContain("alpha")
})

test("edits outside a narrowed region are blocked through normal mutation APIs", () => {
  const buffer = new BufferModel({ name: "x", text: "aa\nbb\ncc\n" })
  const start = buffer.text.indexOf("bb")
  const end = start + 2
  buffer.narrowToRegion(start, end)

  expect(() => buffer.replaceRange(0, 1, "X")).toThrow(/outside narrowed region/)
  expect(() => buffer.deleteRange(end, end + 1)).toThrow(/outside narrowed region/)

  buffer.point = 0
  expect(buffer.point).toBe(start)
  buffer.insert("!")
  expect(buffer.text).toBe("aa\n!bb\ncc\n")
  expect(buffer.restriction).toEqual({ start, end: end + 1 })
})

test("narrow-to-defun uses the mode defun motions in a prog buffer", async () => {
  const editor = makeEditor()
  const text = [
    "def one():",
    "    pass",
    "",
    "def two():",
    "    print('x')",
    "",
    "tail()",
    "",
  ].join("\n")
  const buffer = editor.scratch("example.py", text, "python")
  buffer.point = buffer.text.indexOf("print")

  await editor.run("narrow-to-defun")

  expect(buffer.isNarrowed).toBe(true)
  expect(buffer.text.slice(buffer.pointMin, buffer.pointMax)).toContain("def two():")
  expect(buffer.text.slice(buffer.pointMin, buffer.pointMax)).not.toContain("def one():")
  expect(buffer.text.slice(buffer.pointMin, buffer.pointMax)).not.toContain("tail()")
  expect(selectedBody(editor)).toContain("def two")
  expect(selectedBody(editor)).not.toContain("def one")
})

test("withSavedRestriction restores the previous restriction", () => {
  const buffer = new BufferModel({ name: "x", text: "one\ntwo\nthree\n" })
  const start = buffer.text.indexOf("two")
  const end = start + 3
  buffer.narrowToRegion(start, end)

  const wasNarrowedInside = withSavedRestriction(buffer, () => {
    buffer.widen()
    return buffer.isNarrowed
  })

  expect(wasNarrowedInside).toBe(false)
  expect(buffer.restriction).toEqual({ start, end })
})

test("undo replay across narrowing keeps backing text and restriction coherent", () => {
  const buffer = new BufferModel({ name: "x", text: "aa\nbb\ncc\n" })
  buffer.point = 0
  buffer.insert("ZZ")
  const start = buffer.text.indexOf("bb")
  buffer.narrowToRegion(start, start + 2)

  buffer.undo()

  expect(buffer.text).toBe("aa\nbb\ncc\n")
  expect(buffer.text.slice(buffer.pointMin, buffer.pointMax)).toBe("bb")
  expect(buffer.point).toBe(buffer.pointMin)
  buffer.widen()
  expect(buffer.text).toBe("aa\nbb\ncc\n")
})

function selectedBody(editor: Editor): string {
  return themedTextPlain(selectedPane(buildDisplayModel(editor, { viewport: VIEWPORT })).body)
}

function selectedPane(model: DisplayModel) {
  const leaves = windowLeaves(model.windows)
  return (leaves.find(leaf => leaf.pane.selected) ?? leaves[0]!).pane
}

function windowLeaves(node: WindowDisplayNode): Array<Extract<WindowDisplayNode, { kind: "leaf" }>> {
  return node.kind === "leaf" ? [node] : [...windowLeaves(node.first), ...windowLeaves(node.second)]
}
