import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { makeEditor } from "./plugins/helper"

// An unreadable directory (a network workspace whose credentials expired) used
// to open as an empty Dired listing, and a path below it as a new, empty file.
// Emacs signals `file-error` instead: "Opening directory: Permission denied".
let dir: string
beforeEach(async () => {
  dir = await mkdtemp("/tmp/jemacs-noperm-")
  await chmod(dir, 0o000)
})
afterEach(async () => {
  await chmod(dir, 0o755)
  await rm(dir, { recursive: true, force: true })
})

test("find-file and dired on an unreadable directory signal permission denied", async () => {
  const editor = makeEditor()
  const before = editor.activeBuffer.name
  await expect(editor.run("find-file", [`${dir}/`])).rejects.toThrow(`Opening directory: Permission denied, ${dir}`)
  await expect(editor.run("dired", [dir])).rejects.toThrow(`Opening directory: Permission denied, ${dir}`)
  expect(editor.activeBuffer.name).toBe(before)
})

test("find-file below an unreadable directory does not visit a new file", async () => {
  const editor = makeEditor()
  const target = join(dir, "server", "main.cc")
  await expect(editor.run("find-file", [target])).rejects.toThrow(`Opening input file: Permission denied, ${target}`)
  expect([...editor.buffers.values()].some(b => b.path === target)).toBe(false)
})

test("a missing file still visits as a new file", async () => {
  const editor = makeEditor()
  await chmod(dir, 0o755)
  const target = join(dir, "new.txt")
  await editor.run("find-file", [target])
  expect(editor.activeBuffer.path).toBe(target)
})
