import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { closeWatcherFor, install, pollArmedFor, watchedBuffers } from "../../plugins/auto-revert"
import { setCustom } from "../../src/runtime/custom"
import { clearHooks } from "../../src/kernel/hooks"
import { clearAdvice } from "../../src/runtime/advice"
import type { Editor } from "../../src/kernel/editor"

let dir: string
let editor: Editor

async function waitFor(pred: () => boolean, timeout = 2000): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 10))
  }
  return pred()
}

beforeEach(async () => {
  clearHooks()
  clearAdvice()
  dir = await mkdtemp(join(tmpdir(), "jemacs-autorevert-"))
  editor = makeEditor()
  install(editor)
  setCustom("auto-revert-interval", 0.02)
  setCustom("auto-revert-verbose", false)
})

afterEach(async () => {
  if (editor.isMinorModeEnabled("global-auto-revert-mode")) {
    editor.disableMinorMode("global-auto-revert-mode")
  }
  clearHooks()
  clearAdvice()
  await rm(dir, { recursive: true, force: true })
})

test("global-auto-revert-mode reverts an unmodified buffer when its file changes", async () => {
  const path = join(dir, "a.txt")
  await writeFile(path, "one\n")
  const buf = await editor.openFile(path)
  await editor.run("global-auto-revert-mode")

  expect(editor.isMinorModeEnabled("global-auto-revert-mode")).toBe(true)
  expect(watchedBuffers(editor)).toContain(buf.id)
  expect(buf.text).toBe("one\n")

  await writeFile(path, "two\n")
  const ok = await waitFor(() => buf.text === "two\n")
  expect(ok).toBe(true)
  expect(buf.dirty).toBe(false)
})

test("does not revert a modified buffer", async () => {
  const path = join(dir, "b.txt")
  await writeFile(path, "one\n")
  const buf = await editor.openFile(path)
  await editor.run("global-auto-revert-mode")

  buf.insert("local ")
  expect(buf.dirty).toBe(true)

  await writeFile(path, "two\n")
  const reverted = await waitFor(() => buf.text === "two\n", 200)
  expect(reverted).toBe(false)
  expect(buf.text).toBe("local one\n")
})

test("find-file-hook adopts buffers opened after enabling", async () => {
  await editor.run("global-auto-revert-mode")
  const path = join(dir, "c.txt")
  await writeFile(path, "hello\n")
  const buf = await editor.openFile(path)

  expect(watchedBuffers(editor)).toContain(buf.id)

  await writeFile(path, "world\n")
  const ok = await waitFor(() => buf.text === "world\n")
  expect(ok).toBe(true)
})

test("kill-buffer releases the watcher", async () => {
  const path = join(dir, "d.txt")
  await writeFile(path, "x\n")
  const buf = await editor.openFile(path)
  await editor.run("global-auto-revert-mode")
  expect(watchedBuffers(editor)).toContain(buf.id)

  await editor.run("kill-buffer", [buf.name])
  expect(editor.buffers.has(buf.id)).toBe(false)
  expect(watchedBuffers(editor)).not.toContain(buf.id)
})

test("disabling the mode removes all watchers", async () => {
  const path = join(dir, "e.txt")
  await writeFile(path, "x\n")
  const buf = await editor.openFile(path)
  await editor.run("global-auto-revert-mode")
  expect(watchedBuffers(editor).length).toBe(1)

  await editor.run("global-auto-revert-mode")
  expect(editor.isMinorModeEnabled("global-auto-revert-mode")).toBe(false)
  expect(watchedBuffers(editor).length).toBe(0)

  await writeFile(path, "y\n")
  const reverted = await waitFor(() => buf.text === "y\n", 200)
  expect(reverted).toBe(false)
})

test("point at end of buffer stays at end after revert", async () => {
  const path = join(dir, "f.txt")
  await writeFile(path, "short\n")
  const buf = await editor.openFile(path)
  await editor.run("global-auto-revert-mode")
  buf.point = buf.text.length

  await writeFile(path, "short and now longer\n")
  const ok = await waitFor(() => buf.text === "short and now longer\n")
  expect(ok).toBe(true)
  expect(buf.point).toBe(buf.text.length)
})

/**
 * The fallback poll, which exists because `fs.watch` is best-effort.
 *
 * macOS drops FSEvents callbacks when the process is busy, and a dropped callback used
 * to mean the buffer silently never reverted. These tests close the watcher before
 * touching the file, so the notification path cannot fire at all: any revert that still
 * happens is the poll's doing and nothing else.
 */
test("poll reverts a buffer when the file notification never arrives", async () => {
  setCustom("auto-revert-poll-interval", 0.05)
  const path = join(dir, "poll.txt")
  await writeFile(path, "before\n")
  const buf = await editor.openFile(path)
  await editor.run("global-auto-revert-mode")
  expect(pollArmedFor(editor, buf.id)).toBe(true)

  // Kill the notification path. `closeWatcherFor` leaves the poll running, so the
  // watcher cannot be what reverts the buffer below.
  closeWatcherFor(editor, buf.id)

  await writeFile(path, "after\n")
  expect(await waitFor(() => buf.text === "after\n")).toBe(true)

  setCustom("auto-revert-poll-interval", 1)
})

test("auto-revert-poll-interval 0 disables the poll", async () => {
  setCustom("auto-revert-poll-interval", 0)
  const path = join(dir, "nopoll.txt")
  await writeFile(path, "before\n")
  const buf = await editor.openFile(path)
  await editor.run("global-auto-revert-mode")

  expect(pollArmedFor(editor, buf.id)).toBe(false)
  // The buffer is still watched; only the backstop is off.
  expect(watchedBuffers(editor)).toContain(buf.id)

  setCustom("auto-revert-poll-interval", 1)
})

test("with the poll disabled and the watcher closed, nothing reverts the buffer", async () => {
  setCustom("auto-revert-poll-interval", 0)
  const path = join(dir, "stuck.txt")
  await writeFile(path, "before\n")
  const buf = await editor.openFile(path)
  await editor.run("global-auto-revert-mode")
  closeWatcherFor(editor, buf.id)

  await writeFile(path, "after\n")
  // Negative control: proves the previous test's revert came from the poll rather than
  // from some other path that would have reverted the buffer regardless.
  expect(await waitFor(() => buf.text === "after\n", 400)).toBe(false)
  expect(buf.text).toBe("before\n")

  setCustom("auto-revert-poll-interval", 1)
})

test("kill-buffer clears the poll interval, not just the watcher", async () => {
  setCustom("auto-revert-poll-interval", 0.05)
  const path = join(dir, "leak.txt")
  await writeFile(path, "x\n")
  const buf = await editor.openFile(path)
  await editor.run("global-auto-revert-mode")
  expect(pollArmedFor(editor, buf.id)).toBe(true)

  await editor.run("kill-buffer", [buf.name])

  expect(watchedBuffers(editor)).not.toContain(buf.id)
  expect(pollArmedFor(editor, buf.id)).toBe(false)

  setCustom("auto-revert-poll-interval", 1)
})

test("disabling the mode clears every poll interval", async () => {
  setCustom("auto-revert-poll-interval", 0.05)
  const path = join(dir, "off.txt")
  await writeFile(path, "x\n")
  const buf = await editor.openFile(path)
  await editor.run("global-auto-revert-mode")
  expect(pollArmedFor(editor, buf.id)).toBe(true)

  editor.disableMinorMode("global-auto-revert-mode")

  expect(pollArmedFor(editor, buf.id)).toBe(false)
  expect(watchedBuffers(editor)).toHaveLength(0)

  setCustom("auto-revert-poll-interval", 1)
})
