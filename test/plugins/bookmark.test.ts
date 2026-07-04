import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { installDefaultConfig } from "../../src/config"
import { clearHooks } from "../../src/kernel/hooks"
import { listWindowLeaves } from "../../src/kernel/window"
import { setCustom } from "../../src/runtime/custom"
import { parseEmacsBookmarkFile } from "../../plugins/bookmark/emacs-import"
import { bookmarkImportFromEmacs, install } from "../../plugins/bookmark/index"
import { bookmarkLoad } from "../../plugins/bookmark/store"

let dir: string

beforeEach(async () => {
  clearHooks()
  dir = await mkdtemp(join(homedir(), ".jemacs-test-bookmark-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const EMACS_SAMPLE = `;;;; Emacs Bookmark Format Version 1
(("vibe"
  (filename . "~/programming/vibe/")
  (front-context-string . "_reference\\n  drw")
  (rear-context-string . "28 May 21 20:23 ")
  (position . 93)
  (last-modified 27168 59600 45401 0))
("stephen.el"
  (filename . "~/.emacs.d/stephen.el")
  (front-context-string . ";;; stephen.el -")
  (rear-context-string)
  (position . 1)
  (last-modified 26326 12449 809608 0))
)
`

test("parseEmacsBookmarkFile reads Emacs bookmark entries", () => {
  const table = parseEmacsBookmarkFile(EMACS_SAMPLE)
  expect(Object.keys(table).sort()).toEqual(["stephen.el", "vibe"])
  expect(table.vibe!.filename).toBe(join(homedir(), "programming/vibe/"))
  expect(table.vibe!.position).toBe(92)
  expect(table["stephen.el"]!.position).toBe(0)
})

test("bookmark-set and bookmark-jump round-trip", async () => {
  const editor = makeEditor()
  const file = join(dir, "note.txt")
  await writeFile(file, "hello\nworld\n", "utf8")
  await install(editor)
  setCustom("bookmark-file", join(dir, "bookmarks.json"))

  const buffer = await editor.openFile(file)
  buffer.point = 6

  editor.completingRead = () => Promise.resolve("my-note")
  await editor.run("bookmark-set")

  const saved = JSON.parse(await readFile(join(dir, "bookmarks.json"), "utf8")) as Record<string, { filename: string; position: number }>
  expect(saved["my-note"]).toMatchObject({ filename: file, position: 6 })

  const other = join(dir, "other.txt")
  await writeFile(other, "x", "utf8")
  await editor.openFile(other)

  editor.completingRead = () => Promise.resolve("my-note")
  await editor.run("bookmark-jump")
  expect(editor.currentBuffer.path).toBe(file)
  expect(editor.currentBuffer.point).toBe(6)
})

test("jemacs-bookmark-import-from-emacs writes bookmark-file", async () => {
  const editor = makeEditor()
  const emacsFile = join(dir, "emacs-bookmarks")
  const outFile = join(dir, "bookmarks.json")
  await writeFile(emacsFile, EMACS_SAMPLE, "utf8")
  await install(editor)
  setCustom("bookmark-file", outFile)
  setCustom("bookmark-emacs-file", emacsFile)

  const count = await bookmarkImportFromEmacs(editor, emacsFile)
  expect(count).toBe(2)

  const loaded = await bookmarkLoad()
  expect(Object.keys(loaded).sort()).toEqual(["stephen.el", "vibe"])
})

test("bookmark commands use Emacs names and keys", async () => {
  const editor = makeEditor()
  await install(editor)
  expect(editor.keymaps.lookup("C-x r m")).toMatchObject({ status: "matched", command: "bookmark-set" })
  expect(editor.keymaps.lookup("C-x r b")).toMatchObject({ status: "matched", command: "bookmark-jump" })
  expect(editor.keymaps.lookup("C-x r l")).toMatchObject({ status: "matched", command: "bookmark-bmenu-list" })
  expect(editor.commands.get("list-bookmarks")).toBeDefined()
  expect(editor.commands.get("bookmark-list")).toBeUndefined()
  expect(editor.commands.get("jemacs-bookmark-list")).toBeDefined()
  expect(editor.commands.get("bookmark-import-from-emacs")).toBeUndefined()
  expect(editor.commands.get("jemacs-bookmark-import-from-emacs")).toBeDefined()
  expect(editor.commands.get("bookmark-write")?.description).toContain("file")
  expect(editor.commands.get("bookmark-rename")?.description).toContain("OLD-NAME")
  expect(editor.commands.get("bookmark-jump-other-window")?.description).toContain("another window")
  expect(editor.commands.get("bookmark-insert-location")?.description).toContain("file associated")
  expect(editor.commands.get("bookmark-locate")?.description).toContain("bookmark-insert-location")
  expect(editor.commands.get("bookmark-insert")?.description).toContain("text of the file")
  expect(editor.commands.get("bookmark-relocate")?.description).toContain("another file")
  expect(editor.commands.get("bookmark-delete-all")?.description).toContain("Permanently delete all bookmarks")
})

test("bookmark plugin does not override Emacs rectangle delete key", async () => {
  const editor = makeEditor()
  installDefaultConfig(editor)
  await install(editor)
  expect(editor.commands.get("bookmark-delete")).toBeDefined()
  expect(editor.keymaps.lookup("C-x r d")).toMatchObject({ status: "matched", command: "delete-rectangle" })
})

test("bookmark-write writes bookmarks to a selected file", async () => {
  const editor = makeEditor()
  const file = join(dir, "note.txt")
  const bookmarkFile = join(dir, "bookmarks.json")
  const exportFile = join(dir, "exported-bookmarks.json")
  await writeFile(file, "hello\nworld\n", "utf8")
  await install(editor)
  setCustom("bookmark-file", bookmarkFile)

  const buffer = await editor.openFile(file)
  buffer.point = 6
  await editor.run("bookmark-set", ["my-note"])
  await editor.run("bookmark-write", [exportFile])

  const exported = JSON.parse(await readFile(exportFile, "utf8")) as Record<string, { filename: string; position: number }>
  expect(exported["my-note"]).toMatchObject({ filename: file, position: 6 })
})

test("bookmark-bmenu-list uses the Emacs bookmark list buffer name", async () => {
  const editor = makeEditor()
  const file = join(dir, "note.txt")
  const bookmarkFile = join(dir, "bookmarks.json")
  await writeFile(file, "hello\nworld\n", "utf8")
  await install(editor)
  setCustom("bookmark-file", bookmarkFile)

  const buffer = await editor.openFile(file)
  buffer.point = 6
  await editor.run("bookmark-set", ["my-note"])
  await editor.run("bookmark-bmenu-list")

  expect(editor.currentBuffer.name).toBe("*Bookmark List*")
  expect(editor.currentBuffer.text).toContain("my-note")
  expect(editor.currentBuffer.text).toContain(file)
})

test("bookmark-rename changes a bookmark name", async () => {
  const editor = makeEditor()
  const file = join(dir, "note.txt")
  const bookmarkFile = join(dir, "bookmarks.json")
  await writeFile(file, "hello\nworld\n", "utf8")
  await install(editor)
  setCustom("bookmark-file", bookmarkFile)

  const buffer = await editor.openFile(file)
  buffer.point = 6
  await editor.run("bookmark-set", ["old-note"])
  await editor.run("bookmark-rename", ["old-note", "new-note"])

  const saved = JSON.parse(await readFile(bookmarkFile, "utf8")) as Record<string, { filename: string; position: number }>
  expect(saved["old-note"]).toBeUndefined()
  expect(saved["new-note"]).toMatchObject({ filename: file, position: 6 })

  const other = join(dir, "other.txt")
  await writeFile(other, "x", "utf8")
  await editor.openFile(other)
  await editor.run("bookmark-jump", ["new-note"])
  expect(editor.currentBuffer.path).toBe(file)
  expect(editor.currentBuffer.point).toBe(6)
})

test("bookmark-delete-all deletes every bookmark after confirmation", async () => {
  const editor = makeEditor()
  const file = join(dir, "note.txt")
  const bookmarkFile = join(dir, "bookmarks.json")
  await writeFile(file, "hello\nworld\n", "utf8")
  await install(editor)
  setCustom("bookmark-file", bookmarkFile)

  const buffer = await editor.openFile(file)
  buffer.point = 0
  await editor.run("bookmark-set", ["first"])
  buffer.point = 6
  await editor.run("bookmark-set", ["second"])

  editor.completingRead = () => Promise.resolve("yes")
  await editor.run("bookmark-delete-all")

  const saved = JSON.parse(await readFile(bookmarkFile, "utf8")) as Record<string, unknown>
  expect(saved).toEqual({})
})

test("bookmark-delete-all keeps bookmarks when confirmation is declined", async () => {
  const editor = makeEditor()
  const file = join(dir, "note.txt")
  const bookmarkFile = join(dir, "bookmarks.json")
  await writeFile(file, "hello\nworld\n", "utf8")
  await install(editor)
  setCustom("bookmark-file", bookmarkFile)

  const buffer = await editor.openFile(file)
  buffer.point = 6
  await editor.run("bookmark-set", ["my-note"])

  editor.completingRead = () => Promise.resolve("no")
  await editor.run("bookmark-delete-all")

  const saved = JSON.parse(await readFile(bookmarkFile, "utf8")) as Record<string, { filename: string; position: number }>
  expect(saved["my-note"]).toMatchObject({ filename: file, position: 6 })
})

test("bookmark-relocate changes the bookmarked file and preserves position", async () => {
  const editor = makeEditor()
  const oldFile = join(dir, "old.txt")
  const newFile = join(dir, "new.txt")
  const bookmarkFile = join(dir, "bookmarks.json")
  await writeFile(oldFile, "hello\nworld\n", "utf8")
  await writeFile(newFile, "new target file\n", "utf8")
  await install(editor)
  setCustom("bookmark-file", bookmarkFile)

  const buffer = await editor.openFile(oldFile)
  buffer.point = 6
  await editor.run("bookmark-set", ["my-note"])
  await editor.run("bookmark-relocate", ["my-note", newFile])

  const saved = JSON.parse(await readFile(bookmarkFile, "utf8")) as Record<string, { filename: string; position: number }>
  expect(saved["my-note"]).toMatchObject({ filename: newFile, position: 6 })

  await editor.run("bookmark-jump", ["my-note"])
  expect(editor.currentBuffer.path).toBe(newFile)
  expect(editor.currentBuffer.point).toBe(6)
})

test("bookmark-jump routes tramp-style remote filenames through openFile", async () => {
  const editor = makeEditor()
  const file = join(dir, "note.txt")
  const bookmarkFile = join(dir, "bookmarks.json")
  await writeFile(file, "hello\nworld\n", "utf8")
  await install(editor)
  setCustom("bookmark-file", bookmarkFile)

  const buffer = await editor.openFile(file)
  buffer.point = 6
  await editor.run("bookmark-set", ["remote-note"])
  const remote = "/ssh:example:/home/me/note.txt"
  await editor.run("bookmark-relocate", ["remote-note", remote])

  let opened = ""
  const remoteBuffer = editor.scratch("remote-note.txt", "remote contents", "text")
  remoteBuffer.path = remote
  editor.openFile = async path => {
    opened = path
    editor.switchToBuffer(remoteBuffer.id)
    return remoteBuffer
  }

  await editor.run("bookmark-jump", ["remote-note"])
  expect(opened).toBe(remote)
  expect(editor.currentBuffer).toBe(remoteBuffer)
  expect(editor.currentBuffer.point).toBe(6)
})

test("bookmark-insert-location inserts the bookmarked file name", async () => {
  const editor = makeEditor()
  const file = join(dir, "note.txt")
  const bookmarkFile = join(dir, "bookmarks.json")
  await writeFile(file, "hello\nworld\n", "utf8")
  await install(editor)
  setCustom("bookmark-file", bookmarkFile)

  const buffer = await editor.openFile(file)
  buffer.point = 6
  await editor.run("bookmark-set", ["my-note"])

  const target = editor.scratch("target", "path: ", "text")
  target.point = target.text.length
  await editor.run("bookmark-insert-location", ["my-note"])

  expect(target.text).toBe(`path: ${file}`)
  expect(target.point).toBe(target.text.length)
})

test("bookmark-insert inserts file contents and leaves point before inserted text", async () => {
  const editor = makeEditor()
  const file = join(dir, "note.txt")
  const bookmarkFile = join(dir, "bookmarks.json")
  await writeFile(file, "inserted\ntext", "utf8")
  await install(editor)
  setCustom("bookmark-file", bookmarkFile)

  const source = await editor.openFile(file)
  source.point = 0
  await editor.run("bookmark-set", ["my-note"])

  const target = editor.scratch("target", "a--b", "text")
  target.point = 2
  await editor.run("bookmark-insert", ["my-note"])

  expect(target.text).toBe("a-inserted\ntext-b")
  expect(target.point).toBe(2)
  expect(target.mark).toBe(15)
  expect(target.markActive).toBe(false)
})

test("bookmark-jump-other-window jumps in another selected window", async () => {
  const editor = makeEditor()
  const file = join(dir, "note.txt")
  const otherFile = join(dir, "other.txt")
  const bookmarkFile = join(dir, "bookmarks.json")
  await writeFile(file, "hello\nworld\n", "utf8")
  await writeFile(otherFile, "stay here\n", "utf8")
  await install(editor)
  setCustom("bookmark-file", bookmarkFile)

  const buffer = await editor.openFile(file)
  buffer.point = 6
  await editor.run("bookmark-set", ["my-note"])

  const otherBuffer = await editor.openFile(otherFile)
  const originalWindow = editor.selectedWindowId
  await editor.run("bookmark-jump-other-window", ["my-note"])

  const leaves = listWindowLeaves(editor.windowLayout)
  const originalLeaf = leaves.find(leaf => leaf.id === originalWindow)!
  expect(leaves).toHaveLength(2)
  expect(editor.selectedWindowId).not.toBe(originalWindow)
  expect(originalLeaf.bufferId).toBe(otherBuffer.id)
  expect(editor.currentBuffer.path).toBe(file)
  expect(editor.currentBuffer.point).toBe(6)
})

test("bookmark-edit-annotation sets, shows, persists, and clears", async () => {
  const editor = makeEditor()
  const file = join(dir, "note.txt")
  const bookmarkFile = join(dir, "bookmarks.json")
  await writeFile(file, "hello\nworld\n", "utf8")
  await install(editor)
  setCustom("bookmark-file", bookmarkFile)

  const buffer = await editor.openFile(file)
  buffer.point = 0
  await editor.run("bookmark-set", ["noted"])
  await editor.run("bookmark-edit-annotation", ["noted", "remember this"])

  let saved = JSON.parse(await readFile(bookmarkFile, "utf8")) as Record<string, { annotation?: string }>
  expect(saved["noted"]!.annotation).toBe("remember this")

  await editor.run("bookmark-bmenu-list")
  expect(editor.currentBuffer.text).toContain("remember this")

  let msg = ""
  editor.events.on("message", ({ text }) => { msg = text })
  await editor.run("bookmark-show-annotation", ["noted"])
  expect(msg).toContain("remember this")

  await editor.run("bookmark-edit-annotation", ["noted", ""])
  saved = JSON.parse(await readFile(bookmarkFile, "utf8")) as Record<string, { annotation?: string }>
  expect(saved["noted"]!.annotation).toBeUndefined()
})
