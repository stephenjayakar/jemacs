import { expect, test } from "bun:test"
import { BufferModel } from "../src/kernel/buffer"
import { Editor } from "../src/kernel/editor"
import { addHook, clearHooks, getHooks, modeHookName } from "../src/kernel/hooks"
import { installDefaultHooks } from "../src/config/install-hooks"
import { installLspMode } from "../src/lsp/install"
import { installDefaultModes } from "../src/modes/default-modes"

test("addHook and runHook execute in registration order", async () => {
  clearHooks()
  const editor = new Editor()
  const order: string[] = []
  addHook("find-file-hook", () => { order.push("a") })
  addHook("find-file-hook", () => { order.push("b") })
  const buffer = new BufferModel({ name: "t.txt", text: "", mode: "text" })
  await editor.runHook("find-file-hook", buffer)
  expect(order).toEqual(["a", "b"])
  clearHooks()
})

test("enterMode runs mode-hook", async () => {
  clearHooks()
  installDefaultModes()
  const editor = new Editor()
  let ran = false
  addHook(modeHookName("python"), () => { ran = true })
  const buffer = new BufferModel({ name: "x.py", text: "", mode: "text" })
  editor.addBuffer(buffer)
  editor.enterMode(buffer, "python")
  await editor.runHook(modeHookName("python"), buffer)
  expect(ran).toBe(true)
  expect(buffer.mode).toBe("python")
  clearHooks()
})

test("installLspDeferredHooks registers mode hooks for LSP modes", () => {
  clearHooks()
  const editor = new Editor()
  installLspMode(editor)
  installDefaultHooks(editor)
  expect(getHooks(modeHookName("typescript")).length).toBeGreaterThan(0)
  expect(getHooks(modeHookName("python")).length).toBeGreaterThan(0)
  clearHooks()
})
