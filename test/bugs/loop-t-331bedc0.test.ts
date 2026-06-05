import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"

// t-331bedc0: eval-region/eval-expression let user-code errors escape to
// run-core's top-level catch, so the echo area showed the bare message (or
// stack) with no `Eval error:` context and the trace went to *messages*
// instead of an Emacs-style *Backtrace* buffer. Both must catch locally.
test("eval-expression: throwing user code echoes 'Eval error:' and writes *Backtrace*", async () => {
  const editor = makeEditor()
  let echoed = ""
  editor.events.on("message", ({ text }) => { echoed = text })

  // Should not throw out of the command — the catch is inside.
  await editor.run("eval-expression", ["(() => { throw new Error('kaboom') })()"])

  expect(echoed).toBe("Eval error: kaboom")
  expect(echoed).not.toMatch(/\n|^\s+at /m)

  const backtrace = [...editor.buffers.values()].find(b => b.name === "*Backtrace*")
  expect(backtrace).toBeDefined()
  expect(backtrace!.text).toContain("kaboom")
  expect(backtrace!.text).toMatch(/^\s+at /m)
})

test("eval-region: throwing selection echoes 'Eval error:' and writes *Backtrace*", async () => {
  const editor = makeEditor()
  let echoed = ""
  editor.events.on("message", ({ text }) => { echoed = text })

  const buf = editor.scratch("*t*", "throw new Error('region-boom')\n", "javascript")
  buf.point = 0
  buf.setMark()
  buf.point = buf.text.length

  await editor.run("eval-region")

  expect(echoed).toBe("Eval error: region-boom")
  const backtrace = [...editor.buffers.values()].find(b => b.name === "*Backtrace*")
  expect(backtrace?.text).toContain("region-boom")
})
