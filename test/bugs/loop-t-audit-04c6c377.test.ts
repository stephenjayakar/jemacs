import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { makeEditor } from "../plugins/helper"
import { getTextScaleAmount } from "../../lisp/misc"

// t-audit-04c6c377: lisp/misc.ts kept text-scale-adjust repeat state in
// module-level `let`s (textScaleAdjustRepeatInc, textScaleAdjustMap), which
// (a) leaked across Editor instances and (b) violated the no-module-let-in-lisp
// rule (DESIGN.md §Hot-reload fix 2). State is now WeakMap<Editor,_>-keyed.
//
// t-audit-49fa6b23 (merged): load-plugin called evaluator.loadPlugin without a
// try/catch, so a bad path threw past editor.run instead of surfacing via
// editor.message + *Backtrace* like eval-region/eval-expression do.

test("text-scale-adjust repeat state is per-editor, not module-shared", async () => {
  const a = makeEditor()
  const b = makeEditor()
  await a.run("text-scale-adjust", ["3"])
  expect(getTextScaleAmount(a.currentBuffer)).toBe(3)
  // B has never adjusted; with module-level `let` it would inherit A's repeatInc=3.
  await b.run("text-scale-adjust")
  expect(getTextScaleAmount(b.currentBuffer)).toBe(1)
  // and A's transient overriding map is untouched by B's keyboard-quit
  expect(a.overridingMap).not.toBeNull()
  await b.run("keyboard-quit")
  expect(a.overridingMap).not.toBeNull()
})

test("lisp/misc.ts has no module-level `let` (DESIGN.md fix-2 lint)", () => {
  const src = readFileSync(new URL("../../lisp/misc.ts", import.meta.url), "utf8")
  const offenders = src.split("\n").filter(l => /^let\s/.test(l))
  expect(offenders).toEqual([])
})

test("load-plugin surfaces errors via editor.message, not throw", async () => {
  const editor = makeEditor()
  let msg = ""
  editor.events.on("message", ({ text }) => { msg = text })
  await editor.run("load-plugin", ["/nonexistent/jemacs-plugin.ts"])
  expect(msg).toMatch(/^Load error:/)
  const names = [...editor.buffers.values()].map(b => b.name)
  expect(names).toContain("*Backtrace*")
})
