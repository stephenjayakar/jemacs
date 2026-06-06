import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "../plugins/helper"
import { install as installAutoSave } from "../../plugins/auto-save"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { Editor } from "../../src/kernel/editor"

// t-ec98fca4: kill-buffer falls back to *scratch* (insertion-order head) instead
// of the most-recently-displayed buffer. Emacs falls back via the buffer-list
// recency order maintained by record-buffer.

let dir: string
let editor: Editor
let ctx: PluginContext

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jemacs-t-ec98fca4-"))
  editor = makeEditor()
  installAutoSave(editor, ctx = createPluginContext(editor))
})

afterEach(async () => {
  ctx.dispose()
  editor.stopAutoSave()
  await rm(dir, { recursive: true, force: true })
})

test("kill-buffer falls back to most-recently-displayed buffer, not *scratch*", async () => {
  await writeFile(join(dir, "a.txt"), "a\n")
  await writeFile(join(dir, "b.txt"), "b\n")
  const a = await editor.openFile(join(dir, "a.txt"))
  const b = await editor.openFile(join(dir, "b.txt"))
  expect(editor.currentBuffer.id).toBe(b.id)
  editor.killBuffer()
  // before fix: lands on *scratch* (buffers.values() insertion-order head)
  expect(editor.currentBuffer.id).toBe(a.id)
})

test("kill-buffer recency survives interleaved switching", async () => {
  await writeFile(join(dir, "a.txt"), "a\n")
  await writeFile(join(dir, "b.txt"), "b\n")
  await writeFile(join(dir, "c.txt"), "c\n")
  const a = await editor.openFile(join(dir, "a.txt"))
  await editor.openFile(join(dir, "b.txt"))
  editor.switchToBuffer(a.id)
  const c = await editor.openFile(join(dir, "c.txt"))
  editor.killBuffer()
  // recency before kill: [c, a, b, scratch] → fallback is a, not b (insertion-newest) or scratch
  expect(editor.currentBuffer.id).toBe(a.id)
  editor.killBuffer(c.id) // already gone — no-op
  expect(editor.currentBuffer.id).toBe(a.id)
})

// t-22560900 (merged): openFile must echo the after-find-file warning when a
// newer #FILE# auto-save sits beside the visited file (files.el:2878-2889).
test("openFile warns when #file# auto-save is newer than the visited file", async () => {
  const path = join(dir, "note.txt")
  await writeFile(path, "stale\n")
  const past = Date.now() / 1000 - 60
  await utimes(path, past, past)
  await writeFile(join(dir, "#note.txt#"), "unsaved edits\n")

  let lastMessage = ""
  editor.events.on("message", ({ text }) => { lastMessage = text })
  const buf = await editor.openFile(path)
  expect(buf.text).toBe("stale\n")
  expect(lastMessage).toContain("has auto save data")
  expect(lastMessage).toContain("recover-this-file")
})

test("openFile stays quiet when #file# is older than the visited file", async () => {
  await writeFile(join(dir, "#fresh.txt#"), "old autosave\n")
  const past = Date.now() / 1000 - 60
  await utimes(join(dir, "#fresh.txt#"), past, past)
  await writeFile(join(dir, "fresh.txt"), "current\n")

  let lastMessage = ""
  editor.events.on("message", ({ text }) => { lastMessage = text })
  await editor.openFile(join(dir, "fresh.txt"))
  expect(lastMessage).not.toContain("auto save data")
})
