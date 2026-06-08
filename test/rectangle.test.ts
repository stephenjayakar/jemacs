import { expect, test } from "bun:test"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig } from "../src/config"

function installEditor(): Editor {
  const editor = new Editor()
  installDefaultConfig(editor)
  return editor
}

test("rectangle commands use Emacs names and keys", () => {
  const editor = installEditor()
  expect(editor.commands.get("kill-rectangle")).toBeDefined()
  expect(editor.commands.get("copy-rectangle-as-kill")).toBeDefined()
  expect(editor.commands.get("copy-rectangle-to-register")).toBeDefined()
  expect(editor.commands.get("delete-rectangle")).toBeDefined()
  expect(editor.commands.get("clear-rectangle")).toBeDefined()
  expect(editor.commands.get("open-rectangle")).toBeDefined()
  expect(editor.commands.get("string-rectangle")).toBeDefined()
  expect(editor.commands.get("string-insert-rectangle")).toBeDefined()
  expect(editor.commands.get("rectangle-number-lines")).toBeDefined()
  expect(editor.commands.get("yank-rectangle")).toBeDefined()
  expect(editor.keymaps.lookup("C-x r k")).toMatchObject({ status: "matched", command: "kill-rectangle" })
  expect(editor.keymaps.lookup("C-x r M-w")).toMatchObject({ status: "matched", command: "copy-rectangle-as-kill" })
  expect(editor.keymaps.lookup("C-x r r")).toMatchObject({ status: "matched", command: "copy-rectangle-to-register" })
  expect(editor.keymaps.lookup("C-x r d")).toMatchObject({ status: "matched", command: "delete-rectangle" })
  expect(editor.keymaps.lookup("C-x r c")).toMatchObject({ status: "matched", command: "clear-rectangle" })
  expect(editor.keymaps.lookup("C-x r o")).toMatchObject({ status: "matched", command: "open-rectangle" })
  expect(editor.keymaps.lookup("C-x r t")).toMatchObject({ status: "matched", command: "string-rectangle" })
  expect(editor.keymaps.lookup("C-x r N")).toMatchObject({ status: "matched", command: "rectangle-number-lines" })
  expect(editor.keymaps.lookup("C-x r y")).toMatchObject({ status: "matched", command: "yank-rectangle" })
})

test("copy-rectangle-as-kill copies without deleting and yank-rectangle inserts it", async () => {
  const editor = installEditor()
  const buffer = editor.currentBuffer
  buffer.setText("abcdef\nghijkl\nmnopqr", false)
  buffer.mark = 1
  buffer.point = 17

  await editor.run("copy-rectangle-as-kill")

  expect(buffer.text).toBe("abcdef\nghijkl\nmnopqr")
  buffer.point = 0
  await editor.run("yank-rectangle")
  expect(buffer.text).toBe("bcabcdef\nhighijkl\nnomnopqr")
})

test("copy-rectangle-to-register stores rectangle and prefix deletes it", async () => {
  const editor = installEditor()
  const buffer = editor.currentBuffer
  buffer.setText("abcdef\nghijkl\nmnopqr", false)
  buffer.mark = 1
  buffer.point = 17
  editor.prefixArg.universalArgument()

  await editor.run("copy-rectangle-to-register", ["r"])

  expect(editor.registers.get("r")).toEqual({ kind: "rectangle", lines: ["bc", "hi", "no"] })
  expect(buffer.text).toBe("adef\ngjkl\nmpqr")
  expect(buffer.point).toBe(1)
  expect(buffer.mark).toBeNull()
})

test("delete-rectangle deletes without saving to the kill ring", async () => {
  const editor = installEditor()
  const buffer = editor.currentBuffer
  buffer.setText("abcdef\nghijkl\nmnopqr", false)
  buffer.mark = 1
  buffer.point = 17

  await editor.run("delete-rectangle")

  expect(buffer.text).toBe("adef\ngjkl\nmpqr")
  buffer.point = 0
  await editor.run("yank-rectangle")
  expect(buffer.text).toBe("adef\ngjkl\nmpqr")
})

test("clear-rectangle blanks the selected columns", async () => {
  const editor = installEditor()
  const buffer = editor.currentBuffer
  buffer.setText("abcdef\nghijkl\nmnopqr", false)
  buffer.mark = 1
  buffer.point = 17

  await editor.run("clear-rectangle")

  expect(buffer.text).toBe("a  def\ng  jkl\nm  pqr")
})

test("open-rectangle inserts blank columns", async () => {
  const editor = installEditor()
  const buffer = editor.currentBuffer
  buffer.setText("abcdef\nghijkl\nmnopqr", false)
  buffer.mark = 1
  buffer.point = 17

  await editor.run("open-rectangle")

  expect(buffer.text).toBe("a  bcdef\ng  hijkl\nm  nopqr")
})

test("string rectangle commands replace or insert text on each selected line", async () => {
  const editor = installEditor()
  const buffer = editor.currentBuffer
  buffer.setText("abcdef\nghijkl\nmnopqr", false)
  buffer.mark = 1
  buffer.point = 17

  await editor.run("string-rectangle", ["X"])

  expect(buffer.text).toBe("aXdef\ngXjkl\nmXpqr")

  buffer.mark = 1
  buffer.point = 14
  await editor.run("string-insert-rectangle", [">"])

  expect(buffer.text).toBe("a>Xdef\ng>Xjkl\nm>Xpqr")
})

test("rectangle-number-lines inserts formatted numbers at the rectangle edge", async () => {
  const editor = installEditor()
  const buffer = editor.currentBuffer
  buffer.setText("abcdef\nghijkl\nmnopqr", false)
  buffer.mark = 1
  buffer.point = 17

  await editor.run("rectangle-number-lines", ["7", "[%d] "])

  expect(buffer.text).toBe("a[7] bcdef\ng[8] hijkl\nm[9] nopqr")
  expect(buffer.point).toBe(1)
  expect(buffer.mark).toBeNull()
})

test("rectangle-number-lines uses Emacs default format and pads to the rectangle column", async () => {
  const editor = installEditor()
  const buffer = editor.currentBuffer
  buffer.setText("abcdef\ng\nmnopqr", false)
  buffer.mark = 3
  buffer.point = 12

  await editor.run("rectangle-number-lines", ["9"])

  expect(buffer.text).toBe("abc 9 def\ng  10 \nmno11 pqr")
})
