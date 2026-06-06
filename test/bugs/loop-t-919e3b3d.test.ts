import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { install } from "../../plugins/subword"
import { getHooks, clearHooks } from "../../src/kernel/hooks"

// t-919e3b3d: global-subword-mode's onEnable called ctx.hook("find-file-hook", ...),
// so every off→on toggle stacked another handler. Hoist the hook to install-time
// and gate its body on globalMinorModes.has("global-subword-mode").

test("global-subword-mode: toggling does not accumulate find-file-hook handlers", async () => {
  clearHooks("find-file-hook")
  const editor = makeEditor()
  install(editor)
  const baseline = getHooks("find-file-hook").length

  for (let i = 0; i < 3; i++) {
    editor.enableMinorMode("global-subword-mode")
    editor.disableMinorMode("global-subword-mode")
  }
  expect(getHooks("find-file-hook")).toHaveLength(baseline)

  // Behavioural: with the mode disabled, the hook must not apply subword regexps.
  const buf = editor.scratch("*ff*", "GtkWindow", "text")
  await editor.runHook("find-file-hook", buf)
  expect(buf.locals.has("word-forward-regexp")).toBe(false)

  // And with it enabled, a single handler still does the job.
  editor.enableMinorMode("global-subword-mode")
  const buf2 = editor.scratch("*ff2*", "GtkWindow", "text")
  await editor.runHook("find-file-hook", buf2)
  expect(buf2.locals.has("word-forward-regexp")).toBe(true)
})
