import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { clearHooks } from "../../src/kernel/hooks"
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

test("bookmark-import-from-emacs writes bookmark-file", async () => {
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
  expect(editor.commands.get("bookmark-list")).toBeDefined()
})
