import { afterEach, expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { defineMode } from "../../src/modes/mode"
import { setCustom } from "../../src/runtime/custom"
import { createPluginContext } from "../../src/runtime/plugin-context"
import { cancelTimer, type Timer } from "../../plugins/persist"
import { eldocScheduleTimer, install, type EldocFunction } from "../../plugins/eldoc"

const timers: Timer[] = []
afterEach(() => { for (const t of timers.splice(0)) cancelTimer(t) })
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// t-audit-db79ef5e: module-level `let idleTimer` meant eldocScheduleTimer(editorB)
// cancelled editorA's timer — opening a second frame killed eldoc in the first.
test("eldoc: second editor's idle timer does not cancel the first's", async () => {
  const eldocFunction: EldocFunction = b => `doc:${b.mode}`
  defineMode({ name: "eldoc-multi-a", eldocFunction } as Parameters<typeof defineMode>[0])
  defineMode({ name: "eldoc-multi-b", eldocFunction } as Parameters<typeof defineMode>[0])
  setCustom("eldoc-idle-delay", 0.02)

  const a = makeEditor()
  install(a)
  timers.push(eldocScheduleTimer(a))
  a.enterMode(a.currentBuffer, "eldoc-multi-a")
  let msgA = ""
  a.events.on("message", e => { msgA = e.text })

  const b = makeEditor()
  install(b)
  timers.push(eldocScheduleTimer(b))
  b.enterMode(b.currentBuffer, "eldoc-multi-b")
  let msgB = ""
  b.events.on("message", e => { msgB = e.text })

  await sleep(60)
  expect(msgB).toBe("doc:eldoc-multi-b")
  expect(msgA).toBe("doc:eldoc-multi-a")
})

test("eldoc: ctx.dispose() cancels the editor's idle timer", async () => {
  const eldocFunction: EldocFunction = () => "should-not-fire"
  defineMode({ name: "eldoc-dispose", eldocFunction } as Parameters<typeof defineMode>[0])
  setCustom("eldoc-idle-delay", 0.02)

  const editor = makeEditor()
  const ctx = createPluginContext(editor)
  install(editor, ctx)
  editor.enterMode(editor.currentBuffer, "eldoc-dispose")
  let msg = ""
  editor.events.on("message", e => { msg = e.text })

  ctx.dispose()
  await sleep(60)
  expect(msg).toBe("")
})
