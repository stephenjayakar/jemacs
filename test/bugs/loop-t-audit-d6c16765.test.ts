import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "../plugins/helper"
import { install } from "../../plugins/save-hooks"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { addHook, getHooks } from "../../src/kernel/hooks"

// t-audit-d6c16765: install() called addAdvice("save-buffer") and
// addHook("before-save-hook") directly against the process-global registries.
// evaluator.loadPlugin disposes the previous PluginContext and calls install()
// again on every hot reload, but the plugin never routed through ctx, so each
// reload stacked another advice *and* another hook handler. One save-buffer
// then ran N before-advices each firing N hook handlers — N² before-save runs.
test("save-hooks: N reloads via PluginContext do not compound to N² before-save runs", async () => {
  const editor = makeEditor()
  let ctx: PluginContext | undefined
  for (let i = 0; i < 3; i++) {
    ctx?.dispose()
    ctx = createPluginContext(editor)
    install(editor, ctx)
  }

  // Hook side: ctx.hook records a removeHook disposer, so only the last
  // install's handler should remain.
  expect(getHooks("before-save-hook").length).toBe(1)

  // Advice side: a probe hook fires once per runHook("before-save-hook"),
  // i.e. once per live save-buffer advice. With three stacked advices the
  // probe runs 3× (and the plugin's own handler 3×3 = 9×).
  let probe = 0
  addHook("before-save-hook", () => { probe++ })

  const dir = await mkdtemp(join(tmpdir(), "jemacs-save-"))
  const path = join(dir, "f.txt")
  await writeFile(path, "")
  const buf = await editor.openFile(path)
  buf.setText("x  \n", false)

  await editor.run("save-buffer")

  expect(probe).toBe(1)
  expect(buf.text).toBe("x\n")
})
