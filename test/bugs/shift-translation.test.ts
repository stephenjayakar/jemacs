import { expect, test } from "bun:test"
import { installDefaultConfig } from "../../src/config"
import { Editor } from "../../src/kernel/editor"
import { Keymap, KeymapStack } from "../../src/kernel/keymap"

function stackWith(bindings: Record<string, string>): KeymapStack {
  const km = new Keymap("test")
  for (const [key, command] of Object.entries(bindings)) km.bind(key, command)
  return new KeymapStack(() => [{ name: "test", keymap: km }])
}

test("unbound S-backspace falls back to the backspace binding", () => {
  const fed = stackWith({ backspace: "delete-backward-char" }).feed({ name: "backspace", shift: true })
  expect(fed).toMatchObject({ status: "matched", command: "delete-backward-char" })
})

test("an explicit shifted binding wins over the unshifted one", () => {
  const stack = stackWith({ backspace: "delete-backward-char", "S-backspace": "custom-del" })
  expect(stack.feed({ name: "backspace", shift: true })).toMatchObject({ status: "matched", command: "custom-del" })
})

test("shift-translation applies to the last key of a prefix sequence", () => {
  const stack = stackWith({ "C-x C-n": "next-thing" })
  expect(stack.feed({ name: "x", ctrl: true }).status).toBe("pending")
  expect(stack.feed({ name: "n", ctrl: true, shift: true })).toMatchObject({ status: "matched", command: "next-thing" })
})

test("plain shifted letters are not translated", () => {
  const fed = stackWith({ a: "lower-a" }).feed({ name: "a", shift: true, sequence: "A" })
  expect(fed.status).toBe("unmatched")
})

test("Shift+Backspace deletes backward with the default bindings", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  const buffer = editor.scratch("t.txt", "abc", "fundamental")
  buffer.point = 3
  const result = await editor.handleKey({ name: "backspace", shift: true, sequence: "\x7f" })
  expect(result).toMatchObject({ status: "command", command: "delete-backward-char" })
  expect(buffer.text).toBe("ab")
})
