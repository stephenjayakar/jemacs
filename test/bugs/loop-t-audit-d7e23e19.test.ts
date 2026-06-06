import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { install, cancelPendingGoalUpdate } from "../../plugins/lean4"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { getHooks } from "../../src/kernel/hooks"

// t-audit-d7e23e19: lean4 install() called addHook("post-command-hook") and
// addHook("find-file-hook") directly against the process-global hook registry.
// evaluator.loadPlugin disposes the prior PluginContext and re-runs install()
// on every hot reload, but the plugin never routed through ctx, so each reload
// stacked another handler. post-command-hook fires on *every* keystroke, so N
// reloads meant N debounced plainGoal schedulers racing per key.
// Fix: ctx.hook records a removeHook disposer; ctx.onDispose clears the timer.
test("lean4: N reloads via PluginContext leave exactly one post-command-hook", () => {
  const editor = makeEditor()
  try {
    let ctx: PluginContext | undefined
    for (let i = 0; i < 3; i++) {
      ctx?.dispose()
      ctx = createPluginContext(editor)
      install(editor, ctx)
    }
    expect(getHooks("post-command-hook").length).toBe(1)
    expect(getHooks("find-file-hook").length).toBe(1)
  } finally {
    cancelPendingGoalUpdate(editor)
  }
})
