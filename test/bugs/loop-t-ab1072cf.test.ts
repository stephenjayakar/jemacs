import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { install } from "../../plugins/register-text"

// t-ab1072cf [Feat-6]: RegisterContents lacked {kind:'text'}, so copy-to-register /
// insert-register (C-x r s / C-x r i) — the most common register use — were
// unimplementable even though the C-x r prefix and storage map already exist.

test("copy-to-register stores region text and insert-register inserts it", async () => {
  const editor = makeEditor()
  install(editor)
  const buf = editor.scratch("*t*", "hello world")
  buf.mark = 0
  buf.point = 5
  await editor.run("copy-to-register", ["a"])
  expect(editor.registers.get("a")).toEqual({ kind: "text", text: "hello" })

  buf.point = 11
  await editor.run("insert-register", ["a"])
  expect(buf.text).toBe("hello worldhello")
  expect(buf.point).toBe(16)
  expect(buf.mark).toBe(11)
  expect(buf.markActive).toBe(false)
})

test("copy-to-register and insert-register use Emacs key bindings", async () => {
  const editor = makeEditor()
  install(editor)
  expect(editor.keymaps.lookup("C-x r s")).toMatchObject({ status: "matched", command: "copy-to-register" })
  expect(editor.keymaps.lookup("C-x r x")).toMatchObject({ status: "matched", command: "copy-to-register" })
  expect(editor.keymaps.lookup("C-x r i")).toMatchObject({ status: "matched", command: "insert-register" })
  expect(editor.keymaps.lookup("C-x r g")).toMatchObject({ status: "matched", command: "insert-register" })

  const buf = editor.scratch("*t*", "abc")
  editor.registers.set("q", { kind: "text", text: "XYZ" })
  buf.point = 0
  await editor.run("insert-register", ["q"])
  expect(buf.text).toBe("XYZabc")
})

test("insert-register on empty or non-text register messages instead of inserting", async () => {
  const editor = makeEditor()
  install(editor)
  let msg = ""
  editor.events.on("message", ({ text }) => { msg = text })
  const buf = editor.scratch("*t*", "abc")
  buf.point = 3

  await editor.run("insert-register", ["z"])
  expect(buf.text).toBe("abc")
  expect(msg).toContain("empty")

  editor.registers.set("p", { kind: "point", point: 0 })
  await editor.run("insert-register", ["p"])
  expect(buf.text).toBe("abc")
  expect(msg).toContain("does not contain text")
})

test("jump-to-register refuses text registers (no window-layout corruption)", async () => {
  const editor = makeEditor()
  install(editor)
  let msg = ""
  editor.events.on("message", ({ text }) => { msg = text })
  const layout = editor.windowLayout
  editor.registers.set("t", { kind: "text", text: "oops" })
  await editor.run("jump-to-register", ["t"])
  expect(msg).toContain("does not contain a location")
  expect(editor.windowLayout).toBe(layout)
})

test("copy-to-register with prefix deletes the copied region", async () => {
  const editor = makeEditor()
  install(editor)
  const buf = editor.scratch("*t*", "hello world")
  buf.mark = 0
  buf.point = 5
  editor.prefixArg.universalArgument()

  await editor.run("copy-to-register", ["a"])

  expect(editor.registers.get("a")).toEqual({ kind: "text", text: "hello" })
  expect(buf.text).toBe(" world")
  expect(buf.point).toBe(0)
})

test("insert-register with prefix leaves point before inserted text and mark after", async () => {
  const editor = makeEditor()
  install(editor)
  const buf = editor.scratch("*t*", "ab")
  editor.registers.set("q", { kind: "text", text: "XYZ" })
  buf.point = 1
  editor.prefixArg.universalArgument()

  await editor.run("insert-register", ["q"])

  expect(buf.text).toBe("aXYZb")
  expect(buf.point).toBe(1)
  expect(buf.mark).toBe(4)
  expect(buf.markActive).toBe(false)
})

test("RegisterContents accepts rectangle kind and insert-register handles it", async () => {
  const editor = makeEditor()
  install(editor)
  const buf = editor.scratch("*t*", "")
  editor.registers.set("r", { kind: "rectangle", lines: ["ab", "cd"] })
  await editor.run("insert-register", ["r"])
  expect(buf.text).toBe("ab\ncd")
  expect(buf.mark).toBe(0)
  expect(buf.point).toBe(5)
})
