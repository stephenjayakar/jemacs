import { expect, test } from "bun:test"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig } from "../src/config"
import { installDefaultModes } from "../src/modes/default-modes"
import { buildDisplayModel } from "../src/display/build-display-model"
import { listWindowLeaves } from "../src/kernel/window"

installDefaultModes()

function makeEditor(): Editor {
  const editor = new Editor()
  installDefaultConfig(editor)
  return editor
}

test("an editor starts with exactly one frame owning the window tree", () => {
  const editor = makeEditor()

  expect(editor.frames).toHaveLength(1)
  expect(editor.selectedFrameId).toBe(editor.frames[0]!.id)
  expect(editor.windowLayout).toBe(editor.selectedFrame.layout)
  expect(editor.selectedWindowId).toBe(editor.selectedFrame.selectedWindowId)
})

test("make-frame-command creates and selects a frame with its own window tree", async () => {
  const editor = makeEditor()
  const first = editor.selectedFrame

  await editor.run("make-frame-command")

  expect(editor.frames).toHaveLength(2)
  expect(editor.selectedFrame).not.toBe(first)
  expect(editor.selectedFrame.name).toBe("F2")
  // Splitting the new frame must not disturb the original frame's layout.
  await editor.run("split-window-below")
  expect(listWindowLeaves(editor.selectedFrame.layout)).toHaveLength(2)
  expect(listWindowLeaves(first.layout)).toHaveLength(1)
})

test("frames share buffers, so an edit in one is visible in the other", async () => {
  const editor = makeEditor()
  const shared = editor.scratch("shared.txt", "hello", "text")
  editor.switchToBuffer(shared.id)
  const first = editor.selectedFrame

  await editor.run("make-frame-command")
  expect(editor.currentBuffer.id).toBe(shared.id)
  editor.currentBuffer.setText("hello from the new frame", false)

  editor.selectFrame(first.id)
  expect(editor.buffers.get(shared.id)!.text).toBe("hello from the new frame")
})

test("each frame keeps its own selected window and current buffer", async () => {
  const editor = makeEditor()
  const a = editor.scratch("a.txt", "aaa", "text")
  editor.switchToBuffer(a.id)
  const first = editor.selectedFrame

  await editor.run("make-frame-command")
  const b = editor.scratch("b.txt", "bbb", "text")
  editor.switchToBuffer(b.id)
  const second = editor.selectedFrame

  editor.selectFrame(first.id)
  expect(editor.currentBuffer.name).toBe("a.txt")
  editor.selectFrame(second.id)
  expect(editor.currentBuffer.name).toBe("b.txt")
})

test("other-frame cycles forward and backward through the frame ring", async () => {
  const editor = makeEditor()
  await editor.run("make-frame-command")
  await editor.run("make-frame-command")

  expect(editor.frames.map(frame => frame.name)).toEqual(["F1", "F2", "F3"])
  expect(editor.selectedFrame.name).toBe("F3")

  await editor.run("other-frame")
  expect(editor.selectedFrame.name).toBe("F1")
  // C-u -1 M-x other-frame: cycle the other way.
  editor.prefixArg.addDigit(1)
  editor.prefixArg.toggleNegative()
  await editor.run("other-frame")
  expect(editor.selectedFrame.name).toBe("F3")
})

test("delete-frame removes a frame but never the last one", async () => {
  const editor = makeEditor()
  await editor.run("make-frame-command")
  expect(editor.frames).toHaveLength(2)

  await editor.run("delete-frame")
  expect(editor.frames).toHaveLength(1)
  expect(editor.selectedFrame.name).toBe("F1")

  const messages: string[] = []
  editor.message = text => { messages.push(text); return text }
  await editor.run("delete-frame")
  expect(editor.frames).toHaveLength(1)
  expect(messages).toContain("Attempt to delete the sole frame")
})

test("deleting a frame keeps its buffers alive for the surviving frames", async () => {
  const editor = makeEditor()
  await editor.run("make-frame-command")
  const scratch = editor.scratch("kept.txt", "still here", "text")
  editor.switchToBuffer(scratch.id)

  await editor.run("delete-frame")

  expect(editor.buffers.get(scratch.id)?.text).toBe("still here")
})

test("select-frame-by-name focuses the named frame", async () => {
  const editor = makeEditor()
  await editor.run("make-frame-command")
  expect(editor.selectedFrame.name).toBe("F2")

  await editor.run("select-frame-by-name", ["F1"])
  expect(editor.selectedFrame.name).toBe("F1")

  const messages: string[] = []
  editor.message = text => { messages.push(text); return text }
  await editor.run("select-frame-by-name", ["F9"])
  expect(editor.selectedFrame.name).toBe("F1")
  expect(messages).toContain("No frame named F9")
})

test("C-x 5 prefix reaches the frame commands", () => {
  const editor = makeEditor()

  expect(editor.keymaps.lookup("C-x 5 2")).toMatchObject({ status: "matched", command: "make-frame-command" })
  expect(editor.keymaps.lookup("C-x 5 0")).toMatchObject({ status: "matched", command: "delete-frame" })
  expect(editor.keymaps.lookup("C-x 5 o")).toMatchObject({ status: "matched", command: "other-frame" })
  expect(editor.keymaps.lookup("C-x 5 b")).toMatchObject({ status: "matched", command: "select-frame-by-name" })
})

test("buildDisplayModel renders a requested frame rather than the selected one", async () => {
  const editor = makeEditor()
  const a = editor.scratch("frame-a.txt", "in frame a", "text")
  editor.switchToBuffer(a.id)
  const first = editor.selectedFrame

  await editor.run("make-frame-command")
  const b = editor.scratch("frame-b.txt", "in frame b", "text")
  editor.switchToBuffer(b.id)
  const second = editor.selectedFrame

  const viewport = { rows: 24, cols: 80 }
  const firstModel = buildDisplayModel(editor, { viewport, frameId: first.id })
  const secondModel = buildDisplayModel(editor, { viewport, frameId: second.id })

  expect(paneBufferIds(firstModel.windows)).toEqual([a.id])
  expect(paneBufferIds(secondModel.windows)).toEqual([b.id])
  // Only the frame being rendered marks its window selected.
  expect(firstModel.windows.kind === "leaf" && firstModel.windows.pane.selected).toBe(true)
})

function paneBufferIds(node: ReturnType<typeof buildDisplayModel>["windows"]): string[] {
  if (node.kind === "leaf") return [node.pane.bufferId]
  return [...paneBufferIds(node.first), ...paneBufferIds(node.second)]
}
