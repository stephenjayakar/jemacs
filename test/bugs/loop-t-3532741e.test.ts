import { expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { clearHooks, getHooks } from "../../src/kernel/hooks"
import { trackedContext, getPluginContext } from "../../src/runtime/plugin-context"

// t-3532741e: quit() never tore down plugin contexts, so timers registered via
// ctx.onDispose (auto-save, eldoc, lsp-watchman) outlived the editor. The naive
// fix — import disposeAllContexts into kernel/editor.ts — adds a kernel→runtime
// value dependency. Instead the first trackedContext() call for an editor
// registers a kill-emacs-hook (so lisp/ boot effectively wires it), and quit()
// runs that hook plus stops the kernel-owned auto-save interval.

test("quit() disposes tracked plugin contexts via kill-emacs-hook", async () => {
  clearHooks()
  const editor = new Editor()
  const ctx = trackedContext(editor, "fake-plugin")
  let disposed = false
  ctx.onDispose(() => { disposed = true })

  await editor.quit()

  expect(editor.running).toBe(false)
  expect(disposed).toBe(true)
  expect(getPluginContext(editor, "fake-plugin")).toBeUndefined()
  // hook is removed after dispose so a second editor doesn't accumulate handlers
  expect(getHooks("kill-emacs-hook").length).toBe(0)
})

test("quit() stops the kernel auto-save interval", async () => {
  clearHooks()
  const editor = new Editor()
  editor.startAutoSave()
  await editor.quit()
  // @ts-expect-error private field probe — null means clearInterval ran
  expect(editor.autoSaveTimer).toBeNull()
})
