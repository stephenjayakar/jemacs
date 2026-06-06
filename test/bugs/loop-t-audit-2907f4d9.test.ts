import { expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { createPluginContext, trackedContext, getPluginContext } from "../../src/runtime/plugin-context"
import { getHooks, clearHooks } from "../../src/kernel/hooks"
import { addAdvice, clearAdvice, removeAdvice } from "../../src/runtime/advice"
import { getMinorMode } from "../../src/modes/minor-mode"

// t-audit-2907f4d9: PluginContext disposable-registration end-to-end.
// Before this change, ctx.advice / ctx.command / ctx.key recorded no undo
// thunk and there was no ctx.minorMode, so reloading a plugin stacked hooks,
// advice, and timers. trackedContext now disposes the prior install.

test("ctx.advice removes the advice on dispose()", async () => {
  clearAdvice("probe-cmd")
  const editor = new Editor()
  let n = 0
  editor.command("probe-cmd", () => { n++ })
  const ctx = createPluginContext(editor)
  ctx.advice("probe-cmd", { before: () => { n += 10 } })
  await editor.run("probe-cmd")
  expect(n).toBe(11)
  ctx.dispose()
  await editor.run("probe-cmd")
  expect(n).toBe(12) // advice gone; only the command body ran
})

test("ctx.hook removes the hook on dispose()", () => {
  clearHooks("probe-hook")
  const editor = new Editor()
  const ctx = createPluginContext(editor)
  ctx.hook("probe-hook", () => {})
  expect(getHooks("probe-hook")).toHaveLength(1)
  ctx.dispose()
  expect(getHooks("probe-hook")).toHaveLength(0)
})

test("ctx.minorMode registers and restores prior definition on dispose()", () => {
  const editor = new Editor()
  const ctx1 = createPluginContext(editor)
  ctx1.minorMode({ name: "probe-mm", lighter: " v1" })
  expect(getMinorMode("probe-mm")?.lighter).toBe(" v1")
  const ctx2 = createPluginContext(editor)
  ctx2.minorMode({ name: "probe-mm", lighter: " v2" })
  expect(getMinorMode("probe-mm")?.lighter).toBe(" v2")
  ctx2.dispose()
  expect(getMinorMode("probe-mm")?.lighter).toBe(" v1")
})

test("ctx.command and ctx.key restore prior on dispose()", () => {
  const editor = new Editor()
  editor.command("probe-restore", () => "old")
  editor.defineKey("global-map", "C-c z z", "probe-restore")
  const ctx = createPluginContext(editor)
  ctx.command("probe-restore", () => "new")
  ctx.key("global-map", "C-c z z", "other-command")
  expect(editor.commands.get("probe-restore")?.fn({} as never)).toBe("new")
  expect(editor.keymap.get("C-c z z")).toBe("other-command")
  ctx.dispose()
  expect(editor.commands.get("probe-restore")?.fn({} as never)).toBe("old")
  expect(editor.keymap.get("C-c z z")).toBe("probe-restore")
})

test("trackedContext: re-install under same key disposes the prior ctx", () => {
  clearHooks("tracked-probe")
  const editor = new Editor()
  const install = (_e: Editor, ctx = createPluginContext(_e)) => {
    ctx.hook("tracked-probe", () => {})
  }
  install(editor, trackedContext(editor, "k"))
  install(editor, trackedContext(editor, "k"))
  install(editor, trackedContext(editor, "k"))
  expect(getHooks("tracked-probe")).toHaveLength(1)
  expect(getPluginContext(editor, "k")).toBeDefined()
})

test("removeAdvice exported and drops a single tracked entry", () => {
  clearAdvice("ra-probe")
  const id = addAdvice("ra-probe", { before: () => {} })
  expect(removeAdvice(id)).toBe(true)
  expect(removeAdvice(id)).toBe(false)
})
