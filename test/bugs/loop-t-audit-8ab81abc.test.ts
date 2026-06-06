import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { getTextScaleAmount } from "../../lisp/misc"

// t-audit-8ab81abc — text-scale commands in lisp/misc.ts called the 3-ary
// `editor.command(name, fn, doc)` with a 4th `{ interactive: "p" }` arg.
// JS drops the extra positional silently, so doc still landed; this test pins
// the contract so a future shuffle (object-as-3rd-arg) is caught.
//
// t-audit-04c6c377 (module-level let → WeakMap) and t-audit-49fa6b23
// (load-plugin try/catch) were fixed in the same sweep — behavioral coverage
// lives in loop-t-audit-74741fd3.test.ts.

test("text-scale commands register with a string description (3-ary editor.command)", () => {
  const editor = makeEditor()
  for (const name of ["text-scale-set", "text-scale-increase", "text-scale-decrease", "text-scale-adjust"]) {
    const spec = editor.commands.get(name)
    expect(spec).toBeDefined()
    expect(typeof spec!.description).toBe("string")
    expect(spec!.description!.length).toBeGreaterThan(0)
  }
})

test("text-scale-increase honours its argument", async () => {
  const editor = makeEditor()
  const buffer = editor.currentBuffer
  await editor.run("text-scale-increase", ["2"])
  expect(getTextScaleAmount(buffer)).toBe(2)
  await editor.run("text-scale-increase", ["0"])
  expect(getTextScaleAmount(buffer)).toBe(0)
})
