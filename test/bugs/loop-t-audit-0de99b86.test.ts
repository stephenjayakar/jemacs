import { expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { clearAdvice } from "../../src/runtime/advice"
import { install } from "../../plugins/window"

// t-audit-0de99b86: plugins/window guarded its addAdvice calls with a
// WeakSet<Editor>, but addAdvice writes to a process-global registry. A second
// editor isn't in the WeakSet, so install() re-registers every advice and the
// after-hook runs once per editor that ever installed the plugin.
test("window plugin: auto-balance advice does not accumulate across editors", async () => {
  clearAdvice()
  const a = new Editor()
  install(a)
  const b = new Editor()
  install(b)

  let calls = 0
  b.balanceWindows = () => { calls++ }
  await b.run("split-window")
  expect(calls).toBe(1)
})
