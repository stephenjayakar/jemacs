import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdtemp, readlink, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { install, parseWdiredSymbolicPermissions } from "../../plugins/wdired"
import { keySeq } from "../harness"
import { clearHooks } from "../../src/kernel/hooks"
import { setCustom } from "../../src/runtime/custom"
import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"

let dir: string
let editor: Editor

beforeEach(async () => {
  clearHooks()
  dir = await mkdtemp(join(tmpdir(), "jemacs-wdired-"))
  await writeFile(join(dir, "alpha.txt"), "alpha")
  await writeFile(join(dir, "beta.txt"), "beta")
  editor = makeEditor()
  install(editor)
  setCustom("wdired-allow-to-change-permissions", false)
  setCustom("wdired-allow-to-redirect-links", true)
})

afterEach(async () => {
  clearHooks()
  await rm(dir, { recursive: true, force: true })
})

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

/** Replace the first occurrence of `from` with `to` in the writable buffer. */
function replaceName(buffer: BufferModel, from: string, to: string): void {
  const idx = buffer.text.indexOf(from)
  expect(idx).toBeGreaterThanOrEqual(0)
  buffer.setText(buffer.text.slice(0, idx) + to + buffer.text.slice(idx + from.length))
}

function replaceText(buffer: BufferModel, from: string, to: string): void {
  const idx = buffer.text.indexOf(from)
  expect(idx).toBeGreaterThanOrEqual(0)
  buffer.setText(buffer.text.slice(0, idx) + to + buffer.text.slice(idx + from.length))
}

function replaceSymlinkTarget(buffer: BufferModel, linkName: string, from: string, to: string): void {
  const prefix = `${linkName} -> ${from}`
  const idx = buffer.text.indexOf(prefix)
  expect(idx).toBeGreaterThanOrEqual(0)
  const targetStart = idx + linkName.length + 4
  buffer.setText(buffer.text.slice(0, targetStart) + to + buffer.text.slice(targetStart + from.length))
}

test("parseWdiredSymbolicPermissions parses rwx strings and rejects invalid input", () => {
  expect(parseWdiredSymbolicPermissions("rwxr-x--x")).toBe(0o751)
  expect(parseWdiredSymbolicPermissions("rw-------")).toBe(0o600)
  expect(() => parseWdiredSymbolicPermissions("rwxr-x--")).toThrow(/Invalid permission string/)
  expect(() => parseWdiredSymbolicPermissions("rwxr-S--x")).toThrow(/Invalid permission string/)
})

test("C-x C-q in dired enters wdired mode and makes buffer writable", async () => {
  const buffer = await editor.openDirectory(dir)
  expect(buffer.mode).toBe("dired")
  expect(buffer.readOnly).toBe(true)

  await keySeq(editor, "C-x", "C-q")
  expect(buffer.mode).toBe("wdired")
  expect(buffer.readOnly).toBe(false)
  expect(buffer.dirty).toBe(false)
})

test("wdired-finish-edit renames a changed file and returns to dired", async () => {
  const buffer = await editor.openDirectory(dir)
  await editor.run("wdired-change-to-wdired-mode")

  replaceName(buffer, "alpha.txt", "gamma.txt")
  await keySeq(editor, "C-c", "C-c")

  expect(await exists(join(dir, "gamma.txt"))).toBe(true)
  expect(await exists(join(dir, "alpha.txt"))).toBe(false)
  // Unchanged entry stays put.
  expect(await exists(join(dir, "beta.txt"))).toBe(true)
  expect(buffer.mode).toBe("dired")
  expect(buffer.readOnly).toBe(true)
  expect(buffer.text).toContain("gamma.txt")
  expect(buffer.text).not.toContain("alpha.txt")
})

test("wdired-finish-edit renames multiple files in one commit", async () => {
  const buffer = await editor.openDirectory(dir)
  await editor.run("wdired-change-to-wdired-mode")

  replaceName(buffer, "alpha.txt", "one.txt")
  replaceName(buffer, "beta.txt", "two.txt")
  await editor.run("wdired-finish-edit")

  expect(await exists(join(dir, "one.txt"))).toBe(true)
  expect(await exists(join(dir, "two.txt"))).toBe(true)
  expect(await exists(join(dir, "alpha.txt"))).toBe(false)
  expect(await exists(join(dir, "beta.txt"))).toBe(false)
})

test("wdired-abort-changes restores original buffer and leaves files alone", async () => {
  const buffer = await editor.openDirectory(dir)
  const original = buffer.text
  await editor.run("wdired-change-to-wdired-mode")

  replaceName(buffer, "alpha.txt", "renamed.txt")
  await keySeq(editor, "C-c", "C-k")

  expect(buffer.text).toBe(original)
  expect(buffer.mode).toBe("dired")
  expect(buffer.readOnly).toBe(true)
  expect(await exists(join(dir, "alpha.txt"))).toBe(true)
  expect(await exists(join(dir, "renamed.txt"))).toBe(false)
})

test("wdired-finish-edit with no edits is a no-op", async () => {
  const buffer = await editor.openDirectory(dir)
  await editor.run("wdired-change-to-wdired-mode")

  let lastMessage = ""
  editor.events.on("message", ({ text }) => { lastMessage = text })
  await editor.run("wdired-finish-edit")

  expect(lastMessage).toContain("No changes")
  expect(buffer.mode).toBe("dired")
  expect(await exists(join(dir, "alpha.txt"))).toBe(true)
  expect(await exists(join(dir, "beta.txt"))).toBe(true)
})

test("refuses to enter wdired from a non-dired buffer", async () => {
  let lastMessage = ""
  editor.events.on("message", ({ text }) => { lastMessage = text })
  await editor.run("wdired-change-to-wdired-mode")
  expect(lastMessage).toContain("Not a Dired buffer")
  expect(editor.currentBuffer.mode).not.toBe("wdired")
})

test("inserting a line does not shift rename pairings (zero renames)", async () => {
  await writeFile(join(dir, "gamma.txt"), "gamma")
  const buffer = await editor.openDirectory(dir)
  await editor.run("wdired-change-to-wdired-mode")

  // Insert a blank line at the top — line count changes, names do not.
  buffer.point = 0
  buffer.insert("\n")
  let lastMessage = ""
  editor.events.on("message", ({ text }) => { lastMessage = text })
  await editor.run("wdired-finish-edit")

  // Regression guard for t-86c21ba5: must perform zero renames, zero errors.
  expect(lastMessage).not.toMatch(/Renamed [1-9]/)
  expect(lastMessage).not.toMatch(/error/i)
  expect(await exists(join(dir, "alpha.txt"))).toBe(true)
  expect(await exists(join(dir, "beta.txt"))).toBe(true)
  expect(await exists(join(dir, "gamma.txt"))).toBe(true)
})

test("renaming into a subdirectory creates parent directories", async () => {
  const buffer = await editor.openDirectory(dir)
  await editor.run("wdired-change-to-wdired-mode")
  replaceName(buffer, "alpha.txt", "sub/alpha.txt")
  await editor.run("wdired-finish-edit")

  expect(await exists(join(dir, "sub", "alpha.txt"))).toBe(true)
  expect(await exists(join(dir, "alpha.txt"))).toBe(false)
})

test("wdired-finish-edit chmods edited permission strings when enabled", async () => {
  const path = join(dir, "alpha.txt")
  await chmod(path, 0o600)
  setCustom("wdired-allow-to-change-permissions", true)
  const buffer = await editor.openDirectory(dir)
  await editor.run("wdired-change-to-wdired-mode")

  replaceText(buffer, "rw-------", "rwxr-x--x")
  await editor.run("wdired-finish-edit")

  expect((await stat(path)).mode & 0o777).toBe(0o751)
})

test("wdired-finish-edit does not chmod edited permission strings when disabled", async () => {
  const path = join(dir, "alpha.txt")
  await chmod(path, 0o600)
  const buffer = await editor.openDirectory(dir)
  await editor.run("wdired-change-to-wdired-mode")

  replaceText(buffer, "rw-------", "rwxrwxrwx")
  await editor.run("wdired-finish-edit")

  expect((await stat(path)).mode & 0o777).toBe(0o600)
})

test("wdired-finish-edit keeps renames working when a permission edit is invalid", async () => {
  const buffer = await editor.openDirectory(dir)
  setCustom("wdired-allow-to-change-permissions", true)
  await editor.run("wdired-change-to-wdired-mode")

  replaceText(buffer, "rw-", "rS-")
  replaceName(buffer, "beta.txt", "renamed-beta.txt")
  await editor.run("wdired-finish-edit")

  expect(await exists(join(dir, "renamed-beta.txt"))).toBe(true)
  expect(await exists(join(dir, "beta.txt"))).toBe(false)
})

test("wdired-finish-edit retargets edited symlink arrows", async () => {
  await symlink("alpha.txt", join(dir, "link.txt"))
  const buffer = await editor.openDirectory(dir)
  await editor.run("wdired-change-to-wdired-mode")

  replaceSymlinkTarget(buffer, "link.txt", "alpha.txt", "beta.txt")
  await editor.run("wdired-finish-edit")

  expect(await readlink(join(dir, "link.txt"))).toBe("beta.txt")
})
