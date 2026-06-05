import { expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { addHook, clearHooks, runHooks } from "../../src/kernel/hooks"

// [t-5594b54f] runHooks must isolate each hook: a throwing hook should be
// logged to *messages* and the remaining hooks must still run, so callers
// (post-command-hook → changed(), before-save-hook → save) are not aborted.
test("runHooks isolates a throwing hook and continues", async () => {
  clearHooks("post-command-hook")
  const editor = new Editor()
  const ran: string[] = []
  addHook("post-command-hook", () => { ran.push("a") })
  addHook("post-command-hook", () => { throw new Error("formatter blew up") })
  addHook("post-command-hook", () => { ran.push("c") })

  await runHooks("post-command-hook", { editor, buffer: editor.currentBuffer })

  expect(ran).toEqual(["a", "c"])
  const messages = [...editor.buffers.values()].find(b => b.name === "*messages*")
  expect(messages?.text).toContain("post-command-hook")
  expect(messages?.text).toContain("formatter blew up")
  clearHooks("post-command-hook")
})

test("runHooks isolates an async rejecting hook", async () => {
  clearHooks("before-save-hook")
  const editor = new Editor()
  const ran: string[] = []
  addHook("before-save-hook", async () => { ran.push("a") })
  addHook("before-save-hook", async () => { throw new Error("malformed input") })
  addHook("before-save-hook", async () => { ran.push("c") })

  let threw = false
  try {
    await runHooks("before-save-hook", { editor, buffer: editor.currentBuffer })
  } catch {
    threw = true
  }
  expect(threw).toBe(false)
  expect(ran).toEqual(["a", "c"])
  clearHooks("before-save-hook")
})
