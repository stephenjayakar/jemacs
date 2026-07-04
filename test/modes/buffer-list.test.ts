import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BufferModel } from "../../src/kernel/buffer"
import { listWindowLeaves } from "../../src/kernel/window"
import { keySeq, script } from "../harness"

function rowStart(text: string, needle: string): number {
  const at = text.indexOf(needle)
  expect(at).toBeGreaterThanOrEqual(0)
  return text.lastIndexOf("\n", at) + 1
}

function rowText(text: string, needle: string): string {
  const start = rowStart(text, needle)
  const end = text.indexOf("\n", start)
  return text.slice(start, end === -1 ? text.length : end)
}

test("Buffer Menu flags buffers for delete/save and execute kills and saves them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-buffer-menu-"))
  const path = join(dir, "save-me.txt")
  await writeFile(path, "old")
  const editor = await script({ plugins: false }).done()
  const killMe = editor.addBuffer(new BufferModel({ name: "kill-me", text: "scratch" }))
  const saveMe = editor.addBuffer(new BufferModel({ name: "save-me.txt", path, text: "old" }))

  editor.switchToBuffer(saveMe.id)
  saveMe.point = saveMe.text.length
  saveMe.insert("!")
  await editor.run("list-buffers")
  const list = editor.currentBuffer

  list.point = rowStart(list.text, "kill-me")
  await keySeq(editor, "d")
  expect(rowText(list.text, "kill-me")[1]).toBe("D")

  list.point = rowStart(list.text, "save-me.txt")
  await keySeq(editor, "s")
  expect(rowText(list.text, "save-me.txt")[1]).toBe("S")

  await keySeq(editor, "x")
  expect(editor.buffers.has(killMe.id)).toBe(false)
  expect(editor.buffers.has(saveMe.id)).toBe(true)
  expect(await readFile(path, "utf8")).toBe("old!")
  expect(saveMe.dirty).toBe(false)
  expect(list.text).not.toContain("kill-me")
  expect(rowText(list.text, "save-me.txt")[1]).toBe(" ")
})

test("Buffer Menu unmark commands clear forward and backward marks", async () => {
  const editor = await script({ plugins: false }).done()
  editor.addBuffer(new BufferModel({ name: "one", text: "1" }))
  editor.addBuffer(new BufferModel({ name: "two", text: "2" }))
  editor.addBuffer(new BufferModel({ name: "three", text: "3" }))
  await editor.run("list-buffers")
  const list = editor.currentBuffer

  list.point = rowStart(list.text, "one")
  await keySeq(editor, "d")
  expect(rowText(list.text, "one")[1]).toBe("D")
  list.point = rowStart(list.text, "one")
  await keySeq(editor, "u")
  expect(rowText(list.text, "one")[1]).toBe(" ")

  list.point = rowStart(list.text, "two")
  await keySeq(editor, "d")
  expect(rowText(list.text, "two")[1]).toBe("D")
  await keySeq(editor, "DEL")
  expect(rowText(list.text, "two")[1]).toBe(" ")
})

test("Buffer Menu mark/select opens marked buffers in windows", async () => {
  const editor = await script({ plugins: false }).done()
  const one = editor.addBuffer(new BufferModel({ name: "marked-one", text: "1" }))
  const two = editor.addBuffer(new BufferModel({ name: "marked-two", text: "2" }))
  await editor.run("list-buffers")
  const list = editor.currentBuffer

  list.point = rowStart(list.text, "marked-one")
  await keySeq(editor, "m")
  list.point = rowStart(list.text, "marked-two")
  await keySeq(editor, "m")
  expect(rowText(list.text, "marked-one")[1]).toBe(">")
  expect(rowText(list.text, "marked-two")[1]).toBe(">")

  await keySeq(editor, "v")
  const shown = new Set(listWindowLeaves(editor.windowLayout).map(leaf => leaf.bufferId))
  expect(shown.has(one.id)).toBe(true)
  expect(shown.has(two.id)).toBe(true)
  expect(editor.currentBufferId).toBe(two.id)
})

test("Buffer Menu select visits current line when no buffers are marked", async () => {
  const editor = await script({ plugins: false }).done()
  const target = editor.addBuffer(new BufferModel({ name: "plain-select", text: "x" }))
  await editor.run("list-buffers")
  const list = editor.currentBuffer

  list.point = rowStart(list.text, "plain-select")
  await keySeq(editor, "v")
  expect(editor.currentBufferId).toBe(target.id)
})

test("Buffer Menu toggles file-visiting buffers only", async () => {
  const editor = await script({ plugins: false }).done()
  editor.addBuffer(new BufferModel({ name: "file-only.txt", path: "/tmp/file-only.txt", text: "file" }))
  editor.addBuffer(new BufferModel({ name: "scratch-only", text: "scratch" }))
  await editor.run("list-buffers")
  const list = editor.currentBuffer
  expect(list.text).toContain("file-only.txt")
  expect(list.text).toContain("scratch-only")

  await keySeq(editor, { name: "t", sequence: "T", shift: true })
  expect(list.text).toContain("file-only.txt")
  expect(list.text).not.toContain("scratch-only")
  expect(list.text).not.toContain("*scratch*")

  await keySeq(editor, { name: "t", sequence: "T", shift: true })
  expect(list.text).toContain("file-only.txt")
  expect(list.text).toContain("scratch-only")
})

test("Buffer Menu S cycles sort order by name size and mode", async () => {
  const editor = await script({ plugins: false }).done()
  editor.addBuffer(new BufferModel({ name: "ccc", text: "1", mode: "zmode" }))
  editor.addBuffer(new BufferModel({ name: "aaa", text: "333", mode: "ymode" }))
  editor.addBuffer(new BufferModel({ name: "bbb", text: "22", mode: "xmode" }))
  await editor.run("list-buffers")
  const list = editor.currentBuffer

  const names = () => list.text.split("\n")
    .filter(line => / aaa | bbb | ccc /.test(line))
    .map(line => line.slice(4, 4 + 24).trim())

  // Default is visit order (buffers listed as created).
  expect(names()).toEqual(["ccc", "aaa", "bbb"])
  await keySeq(editor, { name: "s", sequence: "S", shift: true })
  expect(names()).toEqual(["aaa", "bbb", "ccc"])
  await keySeq(editor, { name: "s", sequence: "S", shift: true })
  expect(names()).toEqual(["ccc", "bbb", "aaa"])
  await keySeq(editor, { name: "s", sequence: "S", shift: true })
  expect(names()).toEqual(["bbb", "aaa", "ccc"])
  await keySeq(editor, { name: "s", sequence: "S", shift: true })
  expect(names()).toEqual(["ccc", "aaa", "bbb"])
})
