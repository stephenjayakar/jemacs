import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { script } from "../harness"
import { Evaluator } from "../../src/runtime/evaluator"
import { clearAdvice } from "../../src/runtime/advice"

// t-audit-7c5a1a20: completion-preview guarded its self-insert-command advice
// with a module-level `let adviceInstalled`. evaluator.loadPlugin cache-busts
// the module on every reload, so the fresh module's guard is always false and
// the advice is re-added every time — the guard never prevents anything.
// PluginContext already handles this: ctx.advice records a removeAdvice
// disposer and trackedContext disposes the prior ctx before re-install, so
// each reload leaves exactly one live advice. The guard is dead code that
// violates plugins/CLAUDE.md ("No module-level `let`").
test("completion-preview: N cache-bust reloads leave exactly one self-insert advice", async () => {
  clearAdvice("self-insert-command")
  const editor = await script({ plugins: false }).done()
  const ev = new Evaluator(editor)
  const path = resolve(import.meta.dirname, "../../plugins/completion-preview/index.ts")

  for (let i = 0; i < 3; i++) await ev.loadPlugin(path)

  editor.enableMinorMode("completion-preview-mode")
  editor.enterMode(editor.currentBuffer, "javascript")
  editor.currentBuffer.setText("re", false)
  editor.currentBuffer.point = 2

  // previewShow consults editor.completer once per live advice; one self-insert
  // → one completer call iff exactly one advice survived the reloads.
  let calls = 0
  editor.completer = (input, collection) => {
    calls++
    return collection.filter(c => c.startsWith(input))
  }
  await editor.handleKey({ name: "t", sequence: "t" })
  expect(calls).toBe(1)
})
