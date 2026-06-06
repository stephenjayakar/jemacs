import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "../plugins/helper"
import { install as installAutoSave } from "../../plugins/auto-save"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { Editor } from "../../src/kernel/editor"

// t-eab2bf8d (sujay-dogfood, reconstructed from journal 06-05): kill-buffer
// fell back to *scratch* instead of the previously displayed buffer. Duplicate
// of t-ec98fca4 — fixed by the bufferRecency list maintained in the
// currentBufferId setter (1fbe3de). Pinned here as the dogfood-shaped
// regression: dired → RET on a file → C-x k → expect dired, not *scratch*.
//
// t-22560900 (merged via owns=editor.ts): #autosave# + recover-this-file. Also
// already landed (8b0709a auto-save plugin + openFile warn-on-newer-#FILE#;
// registered in builtin.ts). Pinned here per the merged-detail requirement.

let dir: string
let editor: Editor
let ctx: PluginContext

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jemacs-t-eab2bf8d-"))
  editor = makeEditor()
  installAutoSave(editor, ctx = createPluginContext(editor))
})

afterEach(async () => {
  ctx.dispose()
  editor.stopAutoSave()
  await rm(dir, { recursive: true, force: true })
})

test("kill-buffer after dired → file falls back to dired, not *scratch*", async () => {
  await writeFile(join(dir, "guide.md"), "# guide\n")
  const dired = await editor.openDirectory(dir)
  await editor.run("end-of-buffer")
  await editor.run("dired-find-file")
  expect(editor.currentBuffer.name).toBe("guide.md")
  editor.killBuffer()
  expect(editor.currentBuffer.id).toBe(dired.id)
})

test("kill-buffer falls back to most-recently-selected buffer across longer history", async () => {
  await mkdir(join(dir, "sub"), { recursive: true })
  for (const f of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(dir, f), f)
  const a = await editor.openFile(join(dir, "a.txt"))
  await editor.openFile(join(dir, "b.txt"))
  const c = await editor.openFile(join(dir, "c.txt"))
  editor.switchToBuffer(a.id)
  editor.switchToBuffer(c.id)
  editor.killBuffer()
  // recency before kill: [c, a, b, *scratch*] → fallback a, not insertion-head *scratch*
  expect(editor.currentBuffer.id).toBe(a.id)
})

test("openFile warns 'has auto save data' when #FILE# is newer (t-22560900)", async () => {
  const path = join(dir, "note.txt")
  await writeFile(path, "stale\n")
  const past = Date.now() / 1000 - 60
  await utimes(path, past, past)
  await writeFile(join(dir, "#note.txt#"), "unsaved edits\n")

  let warned = ""
  editor.events.on("message", ({ text }) => { if (text.includes("auto save")) warned = text })
  await editor.openFile(path)
  expect(warned).toContain("recover-this-file")

  // recoverThisFile reads it back when accepted.
  const buf = editor.currentBuffer
  const recovery = editor.recoverThisFile(buf)
  while (!editor.minibuffer) await new Promise(r => setTimeout(r, 1))
  editor.minibufferAccept("y")
  expect(await recovery).toBe(true)
  expect(buf.text).toBe("unsaved edits\n")
})
