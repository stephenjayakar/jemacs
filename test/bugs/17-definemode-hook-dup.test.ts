import { test, expect } from "bun:test"
import { script } from "../harness"
import { defineMode } from "../../src/modes/mode"
import { modeHookName } from "../../src/kernel/hooks"

test("redefining a mode does not duplicate its hooks", async () => {
  let calls = 0
  const h = () => { calls++ }
  await script({ plugins: false })
    .do(() => {
      defineMode({ name: "foo", hooks: [h] })
      defineMode({ name: "foo", hooks: [h] })
    })
    .do((ed, buf) => ed.runHook(modeHookName("foo"), buf))
    .done()
  expect(calls).toBe(1)
})
