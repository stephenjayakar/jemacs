import { afterEach, expect, test } from "bun:test"
import { resolve } from "node:path"
import { makeEditor } from "./helper"
import { fakeLspClient, fakeLspServer } from "../harness/fake-lsp"
import { BufferModel } from "../../src/kernel/buffer"
import { LspManager } from "../../src/lsp/manager"
import { startWorkspace } from "../../src/lsp/workspace"
import { getMode } from "../../src/modes/mode"
import { getClient } from "../../src/lsp/client"
import {
  LEAN_GOAL_DEBOUNCE_MS,
  LEAN_INFO_BUFFER,
  LEAN_KEYWORDS,
  cancelPendingGoalUpdate,
  install,
  leanFontLock,
  leanUpdateInfo,
  renderGoals,
} from "../../plugins/lean4"

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

const editors: ReturnType<typeof makeEditor>[] = []

afterEach(() => {
  for (const ed of editors) cancelPendingGoalUpdate(ed)
  editors.length = 0
})

async function setup() {
  const editor = makeEditor()
  editors.push(editor)
  install(editor)
  const manager = new LspManager(editor)
  editor.lsp = manager
  const path = resolve("/proj/Foo.lean")
  const buffer = new BufferModel({
    name: "Foo.lean",
    path,
    text: "theorem add_zero (n : Nat) : n + 0 = n := by\n  exact rfl\n",
    mode: "lean4",
  })
  editor.addBuffer(buffer)
  editor.switchToBuffer(buffer.id)

  const server = fakeLspServer()
  const client = fakeLspClient(server, { modes: ["lean4"], serverId: "lean" })
  const wsP = startWorkspace(client, "/proj", [buffer])
  server.respond(server.lastRequestId()!, { capabilities: {} })
  const ws = await wsP
  manager.enableLspMode(buffer, [ws])

  return { editor, buffer, server }
}

test("install defines lean4 mode, registers lean client, and binds C-c C-i", () => {
  const editor = makeEditor()
  editors.push(editor)
  install(editor)
  const mode = getMode("lean4")
  expect(mode).toBeDefined()
  expect(mode!.parent).toBe("prog-mode")
  expect(mode!.keymap?.get("C-c C-i")).toBe("lean4-toggle-info")
  expect(editor.commands.get("lean4-toggle-info")).toBeDefined()
  expect(getClient("lean")).toBeDefined()
  expect(getClient("lean")!.majorModes).toContain("lean4")
})

test("leanFontLock highlights keywords, declaration names, comments, and strings", () => {
  const text = `-- a proof\ntheorem add_zero (n : Nat) : n + 0 = n := by\n  exact rfl\ndef greet := "hello"\n`
  const buffer = new BufferModel({ name: "Foo.lean", text, mode: "lean4" })
  const spans = leanFontLock(buffer)
  const at = (word: string, after = 0) => text.indexOf(word, after)
  const span = (start: number) => spans.find(s => s.start === start)

  expect(span(at("-- a proof"))?.face).toBe("comment")
  expect(span(at("theorem"))?.face).toBe("keyword")
  expect(span(at("by"))?.face).toBe("keyword")
  expect(span(at("exact"))?.face).toBe("keyword")
  expect(span(at("def"))?.face).toBe("keyword")
  expect(span(at("add_zero"))?.face).toBe("function")
  expect(span(at("greet"))?.face).toBe("function")
  expect(span(at('"hello"'))?.face).toBe("string")
  // identifiers that aren't keywords get no span
  expect(span(at("rfl"))).toBeUndefined()
  // every requested keyword is in the recognised set
  for (const k of "def theorem lemma axiom instance structure inductive by exact fun match with where let have show".split(" ")) {
    expect(LEAN_KEYWORDS.has(k)).toBe(true)
  }
})

test("renderGoals formats none, one, and many", () => {
  expect(renderGoals(null)).toBe("No goals.")
  expect(renderGoals({ goals: [] })).toBe("No goals.")
  expect(renderGoals({ goals: ["⊢ n + 0 = n"] })).toBe("⊢ n + 0 = n")
  expect(renderGoals({ goals: ["⊢ P", "⊢ Q"] })).toBe("goal 1\n⊢ P\n\ngoal 2\n⊢ Q")
})

test("$/lean/plainGoal at point populates *lean-info* in other window", async () => {
  const { editor, buffer, server } = await setup()
  buffer.point = buffer.text.indexOf("exact")

  const pending = leanUpdateInfo(editor, buffer)
  const req = server.sentBy("$/lean/plainGoal").at(-1)
  expect(req).toBeDefined()
  expect((req!.params as { position: { line: number; character: number } }).position).toEqual({ line: 1, character: 2 })
  server.respond(req!.id!, { goals: ["n : Nat\n⊢ n + 0 = n"], rendered: "" })
  await pending

  const info = [...editor.buffers.values()].find(b => b.name === LEAN_INFO_BUFFER)
  expect(info).toBeDefined()
  expect(info!.text).toBe("n : Nat\n⊢ n + 0 = n")
  // Source buffer keeps focus; *lean-info* is in another window.
  expect(editor.currentBuffer.id).toBe(buffer.id)
  expect(editor.windows).toContain(info!.id)
})

test("post-command-hook debounces plainGoal requests by 200ms", async () => {
  const { editor, buffer, server } = await setup()
  editor.enableMinorMode("lean4-info-mode", { buffer })
  const before = server.sentBy("$/lean/plainGoal").length

  await editor.runHook("post-command-hook", buffer)
  await sleep(LEAN_GOAL_DEBOUNCE_MS / 2)
  await editor.runHook("post-command-hook", buffer)
  await sleep(LEAN_GOAL_DEBOUNCE_MS / 2)
  expect(server.sentBy("$/lean/plainGoal").length).toBe(before)

  await sleep(LEAN_GOAL_DEBOUNCE_MS)
  const reqs = server.sentBy("$/lean/plainGoal")
  expect(reqs.length).toBe(before + 1)
  server.respond(reqs.at(-1)!.id!, { goals: ["⊢ True"] })
  await sleep(0)
  const info = [...editor.buffers.values()].find(b => b.name === LEAN_INFO_BUFFER)
  expect(info?.text).toBe("⊢ True")
})

test("post-command-hook is inert when lean4-info-mode is off or buffer isn't lean4", async () => {
  const { editor, buffer, server } = await setup()
  const before = server.sentBy("$/lean/plainGoal").length

  await editor.runHook("post-command-hook", buffer)
  await sleep(LEAN_GOAL_DEBOUNCE_MS + 50)
  expect(server.sentBy("$/lean/plainGoal").length).toBe(before)

  editor.enableMinorMode("lean4-info-mode", { buffer })
  buffer.mode = "text"
  await editor.runHook("post-command-hook", buffer)
  await sleep(LEAN_GOAL_DEBOUNCE_MS + 50)
  expect(server.sentBy("$/lean/plainGoal").length).toBe(before)
})

test("C-c C-i toggles lean4-info-mode and refreshes immediately on enable", async () => {
  const { editor, buffer, server } = await setup()
  buffer.point = buffer.text.indexOf("by")

  const enable = editor.run("lean4-toggle-info")
  await sleep(0)
  expect(editor.isMinorModeEnabled("lean4-info-mode", buffer)).toBe(true)
  const req = server.sentBy("$/lean/plainGoal").at(-1)
  expect(req).toBeDefined()
  server.respond(req!.id!, { goals: [] })
  await enable
  const info = [...editor.buffers.values()].find(b => b.name === LEAN_INFO_BUFFER)
  expect(info?.text).toBe("No goals.")

  await editor.run("lean4-toggle-info")
  expect(editor.isMinorModeEnabled("lean4-info-mode", buffer)).toBe(false)
})
