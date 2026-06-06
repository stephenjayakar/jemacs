import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { makeEditor } from "../plugins/helper"
import { install, watchedBuffers } from "../../plugins/auto-revert"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { getHooks } from "../../src/kernel/hooks"

// t-audit-0152baea: install() called addHook("find-file-hook") and
// addAdvice("kill-buffer") directly against the process-global registries.
// evaluator.loadPlugin disposes the prior PluginContext and re-runs install()
// on every hot reload, but auto-revert never routed through ctx, so each reload
// stacked another find-file-hook handler and another kill-buffer after-advice.
// ctx.hook/ctx.advice record removeHook/removeAdvice disposers; ctx.onDispose
// also tears down any live fs.watch handles.

test("auto-revert: N reloads via PluginContext do not stack find-file-hook", () => {
  const editor = makeEditor()
  let ctx: PluginContext | undefined
  for (let i = 0; i < 3; i++) {
    ctx?.dispose()
    ctx = createPluginContext(editor)
    install(editor, ctx)
  }
  expect(getHooks("find-file-hook").length).toBe(1)
  ctx?.dispose()
  expect(getHooks("find-file-hook").length).toBe(0)
})

test("auto-revert: ctx.dispose() releases live fs watchers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-autorevert-dispose-"))
  try {
    const path = join(dir, "a.txt")
    await writeFile(path, "x\n")

    const editor = makeEditor()
    const ctx = createPluginContext(editor)
    install(editor, ctx)
    await editor.openFile(path)
    editor.enableMinorMode("global-auto-revert-mode")
    expect(watchedBuffers(editor).length).toBe(1)

    ctx.dispose()
    expect(watchedBuffers(editor)).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
