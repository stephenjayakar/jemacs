import { expect, test } from "bun:test"
import { basename } from "node:path"
import { Editor } from "../../src/kernel/editor"
import { Evaluator, type InstallFn } from "../../src/runtime/evaluator"
import { getPluginContext } from "../../src/runtime/plugin-context"
import { installDefaultModes } from "../../src/modes/default-modes"
import { installLisp } from "../../lisp"
import { installBuiltinPlugins } from "../../plugins/builtin"

// t-audit-5d0cb37b: boot bypassed Evaluator.installPlugin and re-implemented
// trackedContext+install inline. Route every boot install through the
// evaluator chokepoint so instrumentation/dispose policy lives in one place.

class SpyEvaluator extends Evaluator {
  readonly keys: string[] = []
  override async installPlugin(key: string, install: InstallFn): Promise<unknown> {
    this.keys.push(key)
    return super.installPlugin(key, install)
  }
}

test("installLisp routes every module through evaluator.installPlugin", () => {
  installDefaultModes()
  const editor = new Editor()
  const ev = new SpyEvaluator(editor)
  const ret = installLisp(editor, ev)
  expect(ret).toBe(ev)
  const names = ev.keys.map(k => basename(k))
  for (const m of ["simple.ts", "window-cmds.ts", "files.ts", "isearch-ui.ts", "minibuf.ts", "misc.ts"]) {
    expect(names).toContain(m)
  }
  // tracked ctx actually registered under the resolved path
  expect(getPluginContext(ev.editor, ev.keys[0]!)).toBeDefined()
})

test("installBuiltinPlugins routes every plugin through evaluator.installPlugin", async () => {
  installDefaultModes()
  const editor = new Editor()
  const ev = new SpyEvaluator(editor)
  installLisp(editor, ev)
  ev.keys.length = 0
  await installBuiltinPlugins(editor, ev)
  // one installPlugin call per builtin entry; spot-check a few well-known ones
  expect(ev.keys.length).toBeGreaterThan(30)
  const names = ev.keys.map(k => basename(k.replace(/\/index\.ts$/, "")))
  for (const p of ["motion", "mark-ring", "compile", "magit", "tiling"]) {
    expect(names).toContain(p)
  }
  expect(getPluginContext(ev.editor, ev.keys[0]!)).toBeDefined()
})
