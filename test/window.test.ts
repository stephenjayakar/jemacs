import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig as installDefaultCommands } from "../src/config"
import {
  createLeafWindow,
  findWindowLeaf,
  listWindowLeaves,
  splitWindowLeaf,
  type WindowNode,
} from "../src/kernel/window"
import { pageScrollLines } from "../src/display/viewport"

function installEditor(): Editor {
  const editor = new Editor()
  installDefaultCommands(editor)
  return editor
}

async function createThreeTabs(editor: Editor): Promise<void> {
  editor.scratch("a", "a", "text")
  await editor.run("tab-bar-new-tab")
  editor.scratch("b", "b", "text")
  await editor.run("tab-bar-new-tab")
  editor.scratch("c", "c", "text")
}

function tabBufferNames(editor: Editor): Array<string | undefined> {
  return editor.tabs.map(tab => editor.buffers.get(tab.bufferId)?.name)
}

test("split-window-below stacks vertically and keeps the original window selected", async () => {
  const editor = installEditor()
  const start = editor.selectedWindowId
  await editor.run("split-window-below")
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(2)
  expect(editor.windowLayout.kind).toBe("split")
  if (editor.windowLayout.kind === "split") {
    expect(editor.windowLayout.direction).toBe("vertical")
  }
  expect(editor.selectedWindowId).toBe(start)
  expect(editor.selectedWindowId).toBe(listWindowLeaves(editor.windowLayout)[0]!.id)
})

test("split-window-right places panes side by side", async () => {
  const editor = installEditor()
  await editor.run("split-window-right")
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(2)
  if (editor.windowLayout.kind === "split") {
    expect(editor.windowLayout.direction).toBe("horizontal")
  }
})

test("split windows clone the selected window viewport", async () => {
  const editor = installEditor()
  const buffer = editor.currentBuffer
  buffer.setText(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"), false)
  buffer.point = buffer.text.indexOf("line 10")
  editor.setSelectedWindowStartLine(4)

  await editor.run("split-window-below")
  let leaves = listWindowLeaves(editor.windowLayout)
  expect(leaves.map(leaf => leaf.startLine)).toEqual([4, 4])

  await editor.run("other-window")
  editor.setSelectedWindowStartLine(7)
  await editor.run("split-window-right")
  leaves = listWindowLeaves(editor.windowLayout)
  expect(leaves.map(leaf => leaf.startLine)).toEqual([4, 7, 7])
})

test("previous-window-any-frame cycles windows in reverse tree order", async () => {
  const editor = installEditor()
  await editor.run("split-window-below")
  const start = editor.selectedWindowId
  await editor.run("previous-window-any-frame")
  expect(editor.selectedWindowId).not.toBe(start)
})

test("other-window cycles through leaves in tree order", async () => {
  const editor = installEditor()
  await editor.run("split-window-below")
  const leaves = listWindowLeaves(editor.windowLayout)
  expect(editor.selectedWindowId).toBe(leaves[0]!.id)
  await editor.run("other-window")
  expect(editor.selectedWindowId).toBe(leaves[1]!.id)
})

test("other-window honors positive numeric prefix as a skip count", async () => {
  const editor = installEditor()
  await editor.run("split-window-below")
  await editor.run("split-window-right")
  const leaves = listWindowLeaves(editor.windowLayout)
  expect(editor.selectedWindowId).toBe(leaves[0]!.id)

  editor.prefixArg.addDigit(2)
  await editor.run("other-window")
  expect(editor.selectedWindowId).toBe(leaves[2]!.id)
})

test("other-window with zero prefix keeps the selected window", async () => {
  const editor = installEditor()
  await editor.run("split-window-below")
  const start = editor.selectedWindowId

  editor.prefixArg.addDigit(0)
  await editor.run("other-window")
  expect(editor.selectedWindowId).toBe(start)
})

test("other-window honors negative numeric prefix and wraps", async () => {
  const editor = installEditor()
  await editor.run("split-window-below")
  await editor.run("split-window-right")
  const leaves = listWindowLeaves(editor.windowLayout)
  expect(editor.selectedWindowId).toBe(leaves[0]!.id)

  editor.prefixArg.toggleNegative()
  await editor.run("other-window")
  expect(editor.selectedWindowId).toBe(leaves[2]!.id)

  editor.prefixArg.toggleNegative()
  editor.prefixArg.addDigit(4)
  await editor.run("other-window")
  expect(editor.selectedWindowId).toBe(leaves[1]!.id)
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
  await editor.run("other-window")
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
  const savedSelection = editor.selectedWindowId
  await editor.run("window-configuration-to-register", ["w"])
  await editor.run("split-window-below")
  await editor.run("delete-other-windows")
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(1)

  await editor.run("jump-to-register", ["w"])
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(2)
  expect(editor.selectedWindowId).toBe(savedSelection)
  expect(scratch.point).toBe(0)
})

test("quit-window without prefix does not kill the quit buffer", async () => {
  const editor = installEditor()
  const help = editor.scratch("*Help*", "help", "text")
  await editor.run("split-window-below")

  await editor.run("quit-window")
  expect(editor.buffers.has(help.id)).toBe(true)
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(1)
})

test("quit-window with prefix kills the quit buffer", async () => {
  const editor = installEditor()
  const help = editor.scratch("*Help*", "help", "text")
  await editor.run("split-window-below")

  editor.prefixArg.addDigit(0)
  await editor.run("quit-window")
  expect(editor.buffers.has(help.id)).toBe(false)
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(1)
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

test("scroll-other-window numeric prefixes are line counts", async () => {
  const editor = installEditor()
  const buffer = editor.currentBuffer
  buffer.setText(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"), false)
  await editor.run("split-window-below")
  const otherId = editor.selectedWindowId
  await editor.run("other-window")
  const selectedId = editor.selectedWindowId

  editor.prefixArg.addDigit(3)
  await editor.run("scroll-other-window")
  let otherLeaf = listWindowLeaves(editor.windowLayout).find(leaf => leaf.id === otherId)!
  expect(otherLeaf.startLine).toBe(3)
  expect(editor.selectedWindowId).toBe(selectedId)

  editor.prefixArg.addDigit(2)
  await editor.run("scroll-other-window-down")
  otherLeaf = listWindowLeaves(editor.windowLayout).find(leaf => leaf.id === otherId)!
  expect(otherLeaf.startLine).toBe(1)
  expect(editor.selectedWindowId).toBe(selectedId)
})

test("recenter-top-bottom with numeric prefix moves point to that row", async () => {
  const editor = installEditor()
  editor.lastViewport = { rows: 20 }
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n")
  const buffer = editor.scratch("recenter.txt", lines, "text")
  buffer.point = buffer.text.indexOf("line 40")

  editor.prefixArg.addDigit(5)
  await editor.run("recenter-top-bottom")
  expect(findWindowLeaf(editor.windowLayout, editor.selectedWindowId)!.startLine).toBe(34)

  editor.prefixArg.addDigit(0)
  await editor.run("recenter-top-bottom")
  expect(findWindowLeaf(editor.windowLayout, editor.selectedWindowId)!.startLine).toBe(39)
})

test("recenter-top-bottom with negative prefix counts up from the bottom", async () => {
  const editor = installEditor()
  editor.lastViewport = { rows: 20 }
  const page = pageScrollLines(20)
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n")
  const buffer = editor.scratch("recenter.txt", lines, "text")
  buffer.point = buffer.text.indexOf("line 40")

  editor.prefixArg.toggleNegative()
  await editor.run("recenter-top-bottom")
  expect(findWindowLeaf(editor.windowLayout, editor.selectedWindowId)!.startLine).toBe(39 - (page - 1))
})

test("recenter-top-bottom without prefix keeps cycling center top bottom", async () => {
  const editor = installEditor()
  editor.lastViewport = { rows: 20 }
  const page = pageScrollLines(20)
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n")
  const buffer = editor.scratch("recenter.txt", lines, "text")
  buffer.point = buffer.text.indexOf("line 40")

  await editor.run("recenter-top-bottom")
  expect(findWindowLeaf(editor.windowLayout, editor.selectedWindowId)!.startLine).toBe(39 - Math.floor(page / 2))
  await editor.run("recenter-top-bottom")
  expect(findWindowLeaf(editor.windowLayout, editor.selectedWindowId)!.startLine).toBe(39)
  await editor.run("recenter-top-bottom")
  expect(findWindowLeaf(editor.windowLayout, editor.selectedWindowId)!.startLine).toBe(39 - page + 1)
})

test("dedicated windows are skipped when displaying another buffer", async () => {
  const editor = installEditor()
  editor.scratch("*Help*", "help text", "text")
  editor.scratch("other-buffer", "other", "text")
  await editor.run("split-window-below")
  await editor.run("other-window")
  expect(editor.commands.get("toggle-window-dedicated")).toBeUndefined()
  expect(editor.commands.get("jemacs-toggle-window-dedicated")).toBeDefined()
  await editor.run("jemacs-toggle-window-dedicated")
  const dedicatedId = editor.selectedWindowId
  await editor.run("other-window")
  editor.displayBufferInOtherWindow("*Help*")
  expect(editor.currentBuffer.name).toBe("*Help*")
  const dedicatedLeaf = listWindowLeaves(editor.windowLayout).find(leaf => leaf.id === dedicatedId)!
  expect(dedicatedLeaf.bufferId).not.toBe(editor.currentBuffer.id)
})

test("display-buffer-in-child-frame creates a child frame without selecting a tiled window", async () => {
  const editor = installEditor()
  const base = editor.scratch("base", "base", "text")
  const doc = editor.scratch("*doc*", "docs", "text")
  editor.switchToBuffer(base.id)
  const selected = editor.selectedWindowId

  const result = await editor.run("display-buffer-in-child-frame", [doc.id])

  expect(result).toMatchObject({
    parentFrameId: selected,
    visible: true,
  })
  expect(editor.selectedWindowId).toBe(selected)
  expect(editor.currentBuffer.id).toBe(base.id)
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(1)
  expect(editor.childFrames.size).toBe(1)
  expect([...editor.childFrames.values()][0]!.window.bufferId).toBe(doc.id)
})

test("display-buffer action display-buffer-in-child-frame reuses the selected frame's child frame", async () => {
  const editor = installEditor()
  const base = editor.scratch("base", "base", "text")
  const a = editor.scratch("*a*", "a", "text")
  const b = editor.scratch("*b*", "b", "text")
  editor.switchToBuffer(base.id)

  const first = await editor.run("display-buffer", [a.id, "display-buffer-in-child-frame"])
  const second = await editor.run("display-buffer", [b.id, "display-buffer-in-child-frame"])

  expect(editor.childFrames.size).toBe(1)
  expect((first as { id: string }).id).toBe((second as { id: string }).id)
  expect([...editor.childFrames.values()][0]!.window.bufferId).toBe(b.id)
  expect(editor.currentBuffer.id).toBe(base.id)
})

test("find-file-other-window selects the other window", async () => {
  const editor = installEditor()
  const path = "/tmp/jemacs-other-window-test.txt"
  await Bun.write(path, "other window file\n")
  await editor.run("find-file-other-window", [path])
  expect(editor.currentBuffer.path).toBe(path)
  expect(listWindowLeaves(editor.windowLayout).length).toBeGreaterThanOrEqual(1)
})

test("next-buffer honors positive numeric prefix and wraps", async () => {
  const editor = installEditor()
  editor.scratch("a", "a", "text")
  editor.scratch("b", "b", "text")
  editor.scratch("c", "c", "text")
  editor.switchToBuffer("a")

  await editor.run("next-buffer")
  expect(editor.currentBuffer.name).toBe("*messages*")

  editor.switchToBuffer("a")
  editor.prefixArg.addDigit(2)
  await editor.run("next-buffer")
  expect(editor.currentBuffer.name).toBe("*scratch*")

  editor.switchToBuffer("a")
  editor.prefixArg.addDigit(7)
  await editor.run("next-buffer")
  expect(editor.currentBuffer.name).toBe("*scratch*")
})

test("next-buffer with zero prefix keeps the selected buffer", async () => {
  const editor = installEditor()
  editor.scratch("a", "a", "text")
  const start = editor.currentBuffer.id

  editor.prefixArg.addDigit(0)
  await editor.run("next-buffer")
  expect(editor.currentBuffer.id).toBe(start)
})

test("previous-buffer honors positive and negative numeric prefixes", async () => {
  const editor = installEditor()
  editor.scratch("a", "a", "text")
  editor.scratch("b", "b", "text")
  editor.scratch("c", "c", "text")
  editor.switchToBuffer("c")

  editor.prefixArg.addDigit(2)
  await editor.run("previous-buffer")
  expect(editor.currentBuffer.name).toBe("a")

  editor.prefixArg.toggleNegative()
  await editor.run("previous-buffer")
  expect(editor.currentBuffer.name).toBe("b")
})

test("previous-buffer returns to dired after visiting an existing file from dired", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-dired-prev-"))
  try {
    const file = join(dir, "a.txt")
    await writeFile(file, "a\n")
    const editor = installEditor()
    const fileBuffer = await editor.openFile(file)
    const dired = await editor.openDirectory(dir)
    dired.point = dired.text.indexOf("a.txt")

    await editor.run("dired-find-file")
    expect(editor.currentBuffer.id).toBe(fileBuffer.id)

    await editor.run("previous-buffer")
    expect(editor.currentBuffer.id).toBe(dired.id)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("previous-buffer returns to dired after visiting multiple files from dired", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-dired-prev-multiple-"))
  try {
    const a = join(dir, "a.txt")
    const b = join(dir, "b.txt")
    await writeFile(a, "a\n")
    await writeFile(b, "b\n")
    const editor = installEditor()
    const dired = await editor.openDirectory(dir)
    dired.point = dired.text.indexOf("a.txt")

    await editor.run("dired-find-file")
    expect(editor.currentBuffer.path).toBe(a)

    await editor.run("previous-buffer")
    expect(editor.currentBuffer.id).toBe(dired.id)

    dired.point = dired.text.indexOf("b.txt")
    await editor.run("dired-find-file")
    expect(editor.currentBuffer.path).toBe(b)

    await editor.run("previous-buffer")
    expect(editor.currentBuffer.id).toBe(dired.id)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("tab-bar-switch-to-next-tab honors positive numeric prefix and wraps", async () => {
  const editor = installEditor()
  await createThreeTabs(editor)
  editor.selectedTab = 0
  editor.switchToBuffer(editor.tabs[0]!.bufferId)

  editor.prefixArg.addDigit(2)
  await editor.run("tab-bar-switch-to-next-tab")
  expect(editor.selectedTab).toBe(2)
  expect(editor.currentBuffer.name).toBe("c")

  editor.selectedTab = 0
  editor.switchToBuffer(editor.tabs[0]!.bufferId)
  editor.prefixArg.addDigit(4)
  await editor.run("tab-bar-switch-to-next-tab")
  expect(editor.selectedTab).toBe(1)
  expect(editor.currentBuffer.name).toBe("b")
})

test("tab-bar-switch-to-next-tab with zero prefix keeps the selected tab", async () => {
  const editor = installEditor()
  await createThreeTabs(editor)
  editor.selectedTab = 1
  editor.switchToBuffer(editor.tabs[1]!.bufferId)

  editor.prefixArg.addDigit(0)
  await editor.run("tab-bar-switch-to-next-tab")
  expect(editor.selectedTab).toBe(1)
  expect(editor.currentBuffer.name).toBe("b")
})

test("tab-bar-switch-to-prev-tab honors positive and negative numeric prefixes", async () => {
  const editor = installEditor()
  await createThreeTabs(editor)
  editor.selectedTab = 2
  editor.switchToBuffer(editor.tabs[2]!.bufferId)

  editor.prefixArg.addDigit(2)
  await editor.run("tab-bar-switch-to-prev-tab")
  expect(editor.selectedTab).toBe(0)
  expect(editor.currentBuffer.name).toBe("a")

  editor.prefixArg.toggleNegative()
  await editor.run("tab-bar-switch-to-prev-tab")
  expect(editor.selectedTab).toBe(1)
  expect(editor.currentBuffer.name).toBe("b")
})

test("tab-bar-new-tab creates a selected tab to the right by default", async () => {
  const editor = installEditor()
  await createThreeTabs(editor)
  editor.selectedTab = 1
  editor.switchToBuffer(editor.tabs[1]!.bufferId)

  await editor.run("tab-bar-new-tab")
  expect(tabBufferNames(editor)).toEqual(["a", "b", "b", "c"])
  expect(editor.selectedTab).toBe(2)
  expect(editor.currentBuffer.name).toBe("b")
})

test("tab-bar-new-tab honors positive numeric prefixes as relative positions", async () => {
  const editor = installEditor()
  await createThreeTabs(editor)
  editor.selectedTab = 1
  editor.switchToBuffer(editor.tabs[1]!.bufferId)

  editor.prefixArg.addDigit(2)
  await editor.run("tab-bar-new-tab")
  expect(tabBufferNames(editor)).toEqual(["a", "b", "c", "b"])
  expect(editor.selectedTab).toBe(3)
  expect(editor.currentBuffer.name).toBe("b")
})

test("tab-bar-new-tab honors negative numeric prefixes as relative positions", async () => {
  const editor = installEditor()
  await createThreeTabs(editor)
  editor.selectedTab = 1
  editor.switchToBuffer(editor.tabs[1]!.bufferId)

  editor.prefixArg.toggleNegative()
  await editor.run("tab-bar-new-tab")
  expect(tabBufferNames(editor)).toEqual(["b", "a", "b", "c"])
  expect(editor.selectedTab).toBe(0)
  expect(editor.currentBuffer.name).toBe("b")
})

test("tab-bar-new-tab with zero prefix creates the selected tab in place", async () => {
  const editor = installEditor()
  await createThreeTabs(editor)
  editor.selectedTab = 1
  editor.switchToBuffer(editor.tabs[1]!.bufferId)

  editor.prefixArg.addDigit(0)
  await editor.run("tab-bar-new-tab")
  expect(tabBufferNames(editor)).toEqual(["a", "b", "b", "c"])
  expect(editor.selectedTab).toBe(1)
  expect(editor.currentBuffer.name).toBe("b")
})

test("tab-bar-close-tab with numeric prefix closes that absolute tab", async () => {
  const editor = installEditor()
  await createThreeTabs(editor)
  editor.selectedTab = 0
  editor.switchToBuffer(editor.tabs[0]!.bufferId)

  editor.prefixArg.addDigit(2)
  await editor.run("tab-bar-close-tab")
  expect(tabBufferNames(editor)).toEqual(["a", "c"])
  expect(editor.selectedTab).toBe(0)
  expect(editor.currentBuffer.name).toBe("a")
})

test("tab-bar-close-tab adjusts selection when closing a preceding tab", async () => {
  const editor = installEditor()
  await createThreeTabs(editor)
  editor.selectedTab = 2
  editor.switchToBuffer(editor.tabs[2]!.bufferId)

  editor.prefixArg.addDigit(2)
  await editor.run("tab-bar-close-tab")
  expect(tabBufferNames(editor)).toEqual(["a", "c"])
  expect(editor.selectedTab).toBe(1)
  expect(editor.currentBuffer.name).toBe("c")
})

test("tab-bar-close-tab selects the following tab when closing the current tab", async () => {
  const editor = installEditor()
  await createThreeTabs(editor)
  editor.selectedTab = 1
  editor.switchToBuffer(editor.tabs[1]!.bufferId)

  await editor.run("tab-bar-close-tab")
  expect(tabBufferNames(editor)).toEqual(["a", "c"])
  expect(editor.selectedTab).toBe(1)
  expect(editor.currentBuffer.name).toBe("c")
})

test("tab-bar-close-tab ignores out-of-range numeric prefixes", async () => {
  const editor = installEditor()
  await createThreeTabs(editor)
  editor.selectedTab = 1
  editor.switchToBuffer(editor.tabs[1]!.bufferId)

  editor.prefixArg.addDigit(9)
  await editor.run("tab-bar-close-tab")
  expect(tabBufferNames(editor)).toEqual(["a", "b", "c"])
  expect(editor.selectedTab).toBe(1)
  expect(editor.currentBuffer.name).toBe("b")
})

function countDirections(node: WindowNode, direction: "horizontal" | "vertical"): number {
  if (node.kind === "leaf") return 0
  return (node.direction === direction ? 1 : 0)
    + countDirections(node.first, direction)
    + countDirections(node.second, direction)
}
