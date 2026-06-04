import { expect, test } from "bun:test"
import { Editor } from "../src/kernel/editor"
import { installDefaultCommands } from "../src/init/default-commands"
import {
  createLeafWindow,
  listWindowLeaves,
  splitWindowLeaf,
  type WindowNode,
} from "../src/kernel/window"

function installEditor(): Editor {
  const editor = new Editor()
  installDefaultCommands(editor)
  return editor
}

test("split-window-below stacks vertically and selects the new window", async () => {
  const editor = installEditor()
  await editor.run("split-window-below")
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(2)
  expect(editor.windowLayout.kind).toBe("split")
  if (editor.windowLayout.kind === "split") {
    expect(editor.windowLayout.direction).toBe("vertical")
  }
  expect(editor.selectedWindow).toBe(1)
})

test("split-window-right places panes side by side", async () => {
  const editor = installEditor()
  await editor.run("split-window-right")
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(2)
  if (editor.windowLayout.kind === "split") {
    expect(editor.windowLayout.direction).toBe("horizontal")
  }
})

test("other-window-backward cycles windows in reverse tree order", async () => {
  const editor = installEditor()
  await editor.run("split-window-below")
  const start = editor.selectedWindowId
  await editor.run("other-window-backward")
  expect(editor.selectedWindowId).not.toBe(start)
})

test("other-window cycles through leaves in tree order", async () => {
  const editor = installEditor()
  await editor.run("split-window-below")
  expect(editor.selectedWindow).toBe(1)
  await editor.run("other-window")
  expect(editor.selectedWindow).toBe(0)
})

test("delete-other-windows keeps only the selected pane", async () => {
  const editor = installEditor()
  await editor.run("split-window-below")
  await editor.run("other-window")
  await editor.run("delete-other-windows")
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(1)
  expect(editor.windowLayout.kind).toBe("leaf")
})

test("delete-window removes the selected pane", async () => {
  const editor = installEditor()
  await editor.run("split-window-right")
  await editor.run("delete-window")
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(1)
})

test("split windows preserve independent points into the same buffer", async () => {
  const editor = installEditor()
  const buffer = editor.currentBuffer
  buffer.setText("alpha\nbeta\ngamma", false)
  buffer.point = 0
  await editor.run("split-window-below")
  buffer.point = 11
  await editor.run("other-window")
  expect(buffer.point).toBe(0)
  await editor.run("other-window")
  expect(buffer.point).toBe(11)
})

test("split below then split right builds a vertical branch with a horizontal sub-split", async () => {
  const editor = installEditor()
  await editor.run("split-window-below")
  await editor.run("split-window-right")
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(3)
  const layout = editor.windowLayout
  expect(layout.kind).toBe("split")
  if (layout.kind !== "split") return
  expect(layout.direction).toBe("vertical")
  expect(layout.second.kind).toBe("split")
  if (layout.second.kind !== "split") return
  expect(layout.second.direction).toBe("horizontal")
  expect(listWindowLeaves(layout.second)).toHaveLength(2)
})

test("splitWindowLeaf builds nested layouts", () => {
  const root = createLeafWindow("a", 0)
  const below = splitWindowLeaf(root, root.id, "vertical", "a", 0)
  const right = splitWindowLeaf(below.layout, below.newWindowId, "horizontal", "a", 0)
  const leaves = listWindowLeaves(right.layout)
  expect(leaves).toHaveLength(3)
  expect(countDirections(right.layout, "vertical")).toBe(1)
  expect(countDirections(right.layout, "horizontal")).toBe(1)
})

test("window-configuration-to-register restores layout and selection", async () => {
  const editor = installEditor()
  const scratch = editor.currentBuffer
  scratch.setText("one\ntwo\nthree", false)
  await editor.run("split-window-right")
  await editor.run("other-window")
  scratch.point = 0
  await editor.run("window-configuration-to-register", ["w"])
  await editor.run("split-window-below")
  await editor.run("delete-other-windows")
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(1)

  await editor.run("jump-to-register", ["w"])
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(2)
  expect(editor.selectedWindow).toBe(0)
  expect(scratch.point).toBe(0)
})

test("scroll-other-window scrolls the next window without selecting it", async () => {
  const editor = installEditor()
  const buffer = editor.currentBuffer
  buffer.setText(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"), false)
  buffer.point = 0
  await editor.run("split-window-below")
  const otherId = editor.selectedWindowId
  await editor.run("other-window")
  const selectedId = editor.selectedWindowId
  expect(selectedId).not.toBe(otherId)

  await editor.run("scroll-other-window")
  const otherLeaf = listWindowLeaves(editor.windowLayout).find(leaf => leaf.id === otherId)!
  expect(otherLeaf.startLine).toBeGreaterThan(0)
  expect(editor.selectedWindowId).toBe(selectedId)
})

test("dedicated windows are skipped when displaying another buffer", async () => {
  const editor = installEditor()
  editor.scratch("*Help*", "help text", "text")
  editor.scratch("other-buffer", "other", "text")
  await editor.run("split-window-below")
  await editor.run("other-window")
  await editor.run("toggle-window-dedicated")
  await editor.run("other-window")
  editor.displayBufferInOtherWindow("*Help*")
  expect(editor.currentBuffer.name).toBe("*Help*")
  const dedicatedLeaf = listWindowLeaves(editor.windowLayout).find(leaf => leaf.dedicated)!
  expect(dedicatedLeaf.bufferId).not.toBe(editor.currentBuffer.id)
})

test("find-file-other-window selects the other window", async () => {
  const editor = installEditor()
  const path = "/tmp/jemacs-other-window-test.txt"
  await Bun.write(path, "other window file\n")
  await editor.run("find-file-other-window", [path])
  expect(editor.currentBuffer.path).toBe(path)
  expect(listWindowLeaves(editor.windowLayout).length).toBeGreaterThanOrEqual(1)
})

function countDirections(node: WindowNode, direction: "horizontal" | "vertical"): number {
  if (node.kind === "leaf") return 0
  return (node.direction === direction ? 1 : 0)
    + countDirections(node.first, direction)
    + countDirections(node.second, direction)
}
