import { expect, test } from "bun:test"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig as installDefaultCommands } from "../src/config"
import { findWindowLeaf, listWindowLeaves, type WindowNode } from "../src/kernel/window"

function installEditor(): Editor {
  const editor = new Editor()
  installDefaultCommands(editor)
  return editor
}

function leafIds(node: WindowNode): string[] {
  return listWindowLeaves(node).map(leaf => leaf.id)
}

test("split→split→delete-middle preserves the outer siblings", async () => {
  const editor = installEditor()
  // A → split-below → vsplit(A, B) → split-below → vsplit(A, vsplit(B, C))
  await editor.run("split-window-below")
  await editor.run("split-window-below")
  const before = leafIds(editor.windowLayout)
  expect(before).toHaveLength(3)
  const [a, b, c] = before as [string, string, string]

  // Selection is on C (the newest leaf); step back one to land on B.
  expect(editor.selectedWindowId).toBe(c)
  await editor.run("previous-window-any-frame")
  expect(editor.selectedWindowId).toBe(b)

  await editor.run("delete-window")

  const after = leafIds(editor.windowLayout)
  expect(after).toEqual([a, c])
  expect(editor.windowLayout.kind).toBe("split")
  if (editor.windowLayout.kind === "split") {
    expect(editor.windowLayout.direction).toBe("vertical")
    expect(editor.windowLayout.first.kind).toBe("leaf")
    expect(editor.windowLayout.second.kind).toBe("leaf")
  }
  // delete-window selects the next leaf in tree order, which is C.
  expect(editor.selectedWindowId).toBe(c)
  // Neither survivor's buffer was disturbed.
  expect(findWindowLeaf(editor.windowLayout, a)?.bufferId).toBe(editor.currentBuffer.id)
  expect(findWindowLeaf(editor.windowLayout, c)?.bufferId).toBe(editor.currentBuffer.id)
})

test("delete-other-windows from a deep leaf collapses to that leaf", async () => {
  const editor = installEditor()
  // Build vsplit(A, hsplit(B, vsplit(C, D))); selection ends on D, three splits deep.
  await editor.run("split-window-below")
  await editor.run("split-window-right")
  await editor.run("split-window-below")
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(4)

  const deepId = editor.selectedWindowId
  const deepLeaf = findWindowLeaf(editor.windowLayout, deepId)!
  // Sanity: D really is nested under two split nodes, not a top-level child.
  expect(editor.windowLayout.kind).toBe("split")
  if (editor.windowLayout.kind === "split") {
    expect(editor.windowLayout.first.kind).toBe("leaf")
    expect(editor.windowLayout.second.kind).toBe("split")
  }

  await editor.run("delete-other-windows")

  expect(editor.windowLayout.kind).toBe("leaf")
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(1)
  if (editor.windowLayout.kind === "leaf") {
    expect(editor.windowLayout.id).toBe(deepId)
    expect(editor.windowLayout.bufferId).toBe(deepLeaf.bufferId)
  }
  expect(editor.selectedWindowId).toBe(deepId)
})

test("window-configuration-to-register round-trips through repeated layout changes", async () => {
  const editor = installEditor()
  await editor.run("split-window-right")
  await editor.run("split-window-below")
  const savedIds = leafIds(editor.windowLayout)
  const savedSelection = editor.selectedWindowId
  expect(savedIds).toHaveLength(3)

  await editor.run("window-configuration-to-register", ["r"])

  // First round of layout changes: tear everything down to a single leaf.
  await editor.run("delete-other-windows")
  await editor.run("split-window-below")
  expect(leafIds(editor.windowLayout)).not.toEqual(savedIds)

  await editor.run("jump-to-register", ["r"])
  expect(leafIds(editor.windowLayout)).toEqual(savedIds)
  expect(editor.selectedWindowId).toBe(savedSelection)

  // Second round: mutate the restored tree, then restore again. The register
  // snapshot must not have been aliased to the live layout in either direction.
  await editor.run("split-window-right")
  await editor.run("other-window")
  await editor.run("delete-window")
  expect(leafIds(editor.windowLayout)).not.toEqual(savedIds)

  await editor.run("jump-to-register", ["r"])
  expect(leafIds(editor.windowLayout)).toEqual(savedIds)
  expect(editor.selectedWindowId).toBe(savedSelection)
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(3)
})
