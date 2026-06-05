import { beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { install, deleteTrailingWhitespace } from "../../plugins/save-hooks"
import { clearAdvice } from "../../src/runtime/advice"
import { addHook, clearHooks } from "../../src/kernel/hooks"

beforeEach(() => {
  clearAdvice("save-buffer")
  clearHooks("before-save-hook")
  clearHooks("after-save-hook")
})

test("delete-trailing-whitespace strips spaces and tabs at end of each line", async () => {
  const editor = makeEditor()
  install(editor)
  const buf = editor.currentBuffer
  buf.setText("foo   \nbar\t\t\nbaz\n", false)

  await editor.run("delete-trailing-whitespace")

  expect(buf.text).toBe("foo\nbar\nbaz\n")
})

test("delete-trailing-whitespace preserves point relative to surviving text", () => {
  const editor = makeEditor()
  install(editor)
  const buf = editor.currentBuffer
  buf.setText("ab  \ncd  \nef", false)
  buf.point = 6

  deleteTrailingWhitespace(buf)

  expect(buf.text).toBe("ab\ncd\nef")
  expect(buf.text[buf.point]).toBe("d")
})

test("delete-trailing-whitespace on active region leaves other lines untouched", async () => {
  const editor = makeEditor()
  install(editor)
  const buf = editor.currentBuffer
  buf.setText("keep  \nstrip  \nkeep  ", false)
  buf.point = 7
  buf.setMark()
  buf.point = 14

  await editor.run("delete-trailing-whitespace")

  expect(buf.text).toBe("keep  \nstrip\nkeep  ")
})

test("delete-trailing-whitespace deletes trailing blank lines when acting on whole buffer", () => {
  const editor = makeEditor()
  install(editor)
  const buf = editor.currentBuffer
  buf.setText("body\n\n\n", false)

  deleteTrailingWhitespace(buf)

  expect(buf.text).toBe("body\n")
})

test("delete-trailing-whitespace is a no-op when nothing to strip", () => {
  const editor = makeEditor()
  install(editor)
  const buf = editor.currentBuffer
  buf.setText("clean\ntext\n", false)
  buf.dirty = false

  deleteTrailingWhitespace(buf)

  expect(buf.text).toBe("clean\ntext\n")
  expect(buf.dirty).toBe(false)
})

test("before-save-hook and after-save-hook fire around save-buffer", async () => {
  const editor = makeEditor()
  install(editor)
  const dir = await mkdtemp(join(tmpdir(), "jemacs-save-"))
  const path = join(dir, "file.txt")
  await writeFile(path, "")
  const buf = await editor.openFile(path)
  buf.setText("hello", false)

  const events: string[] = []
  addHook("before-save-hook", () => { events.push("before") })
  addHook("after-save-hook", () => { events.push("after") })
  const realSave = buf.save.bind(buf)
  buf.save = async () => { events.push("save"); await realSave() }

  await editor.run("save-buffer")

  expect(events).toEqual(["before", "save", "after"])
  expect(buf.dirty).toBe(false)
})

test("default before-save-hook strips trailing whitespace and writes clean text", async () => {
  const editor = makeEditor()
  install(editor)
  const dir = await mkdtemp(join(tmpdir(), "jemacs-save-"))
  const path = join(dir, "file.txt")
  await writeFile(path, "")
  const buf = await editor.openFile(path)
  buf.setText("line one   \nline two\t\n", false)

  await editor.run("save-buffer")

  expect(buf.text).toBe("line one\nline two\n")
  const onDisk = await readFile(path, "utf8")
  expect(onDisk).toBe("line one\nline two\n")
})

test("error in before-save-hook does not prevent save", async () => {
  const editor = makeEditor()
  install(editor)
  const dir = await mkdtemp(join(tmpdir(), "jemacs-save-"))
  const path = join(dir, "file.txt")
  await writeFile(path, "old")
  const buf = await editor.openFile(path)
  buf.setText("new", false)

  addHook("before-save-hook", () => { throw new Error("boom") })

  await editor.run("save-buffer")

  const onDisk = await readFile(path, "utf8")
  expect(onDisk).toBe("new")
})
