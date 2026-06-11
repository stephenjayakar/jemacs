import { expect, test } from "bun:test"
import { PrefixArgumentState } from "../src/kernel/prefix-argument"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig } from "../src/config"

test("PrefixArgumentState C-u multiplies by 4", () => {
  const p = new PrefixArgumentState()
  expect(p.universalArgument()).toBe(4)
  expect(p.universalArgument()).toBe(16)
  expect(p.consume()).toBe(16)
  expect(p.peek()).toBeNull()
})

test("PrefixArgumentState C-u digit sets argument", () => {
  const p = new PrefixArgumentState()
  p.universalArgument()
  p.addDigit(5)
  expect(p.consume()).toBe(5)
})

test("PrefixArgumentState M-- negates", () => {
  const p = new PrefixArgumentState()
  p.universalArgument()
  p.toggleNegative()
  expect(p.consume()).toBe(-4)
})

test("C-u 5 f moves five characters via keymap", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  editor.currentBuffer.setText("abcdef", false)
  editor.currentBuffer.point = 0

  await editor.handleKey({ name: "u", ctrl: true })
  await editor.handleKey({ name: "5", sequence: "5" })
  expect(await editor.handleKey({ name: "f", ctrl: true })).toEqual({ status: "command", command: "forward-char" })
  expect(editor.currentBuffer.point).toBe(5)
})

test("self-insert-command is used for printable keys", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  editor.currentBuffer.setText("", false)

  const result = await editor.handleKey({ name: "a", sequence: "a" })
  expect(result).toEqual({ status: "command", command: "self-insert-command" })
  expect(editor.currentBuffer.text).toBe("a")
})

// ── Raw prefix shape tests ──────────────────────────────────────

test("rawShape: plain C-u is plain-cu with value 4", () => {
  const p = new PrefixArgumentState()
  p.universalArgument()
  expect(p.rawShape()).toEqual({ kind: "plain-cu", value: 4 })
})

test("rawShape: repeated C-u is plain-cu with value 16", () => {
  const p = new PrefixArgumentState()
  p.universalArgument()
  p.universalArgument()
  expect(p.rawShape()).toEqual({ kind: "plain-cu", value: 16 })
})

test("rawShape: C-u 5 is explicit with value 5", () => {
  const p = new PrefixArgumentState()
  p.universalArgument()
  p.addDigit(5)
  expect(p.rawShape()).toEqual({ kind: "explicit", value: 5 })
})

test("rawShape: C-u 0 is explicit with value 0", () => {
  const p = new PrefixArgumentState()
  p.universalArgument()
  p.addDigit(0)
  expect(p.rawShape()).toEqual({ kind: "explicit", value: 0 })
})

test("rawShape: bare M-- is bare-negative", () => {
  const p = new PrefixArgumentState()
  p.toggleNegative()
  expect(p.rawShape()).toEqual({ kind: "bare-negative" })
})

test("rawShape: M-- 3 is explicit with value -3", () => {
  const p = new PrefixArgumentState()
  p.toggleNegative()
  p.addDigit(3)
  expect(p.rawShape()).toEqual({ kind: "explicit", value: -3 })
})

test("rawShape: C-u M-- is plain-cu with value -4", () => {
  const p = new PrefixArgumentState()
  p.universalArgument()
  p.toggleNegative()
  expect(p.rawShape()).toEqual({ kind: "plain-cu", value: -4 })
})

test("rawShape: no prefix is none", () => {
  const p = new PrefixArgumentState()
  expect(p.rawShape()).toEqual({ kind: "none" })
})

test("consumeRaw returns both raw and value", () => {
  const p = new PrefixArgumentState()
  p.universalArgument()
  p.addDigit(0)
  const result = p.consumeRaw()
  expect(result).toEqual({ raw: { kind: "explicit", value: 0 }, value: 0 })
  expect(p.peek()).toBeNull()
})

test("rawPrefixShape is passed through to commands", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  let capturedShape: unknown = null
  editor.command("test-raw-shape", (ctx) => { capturedShape = ctx.rawPrefixShape })

  // No prefix
  await editor.run("test-raw-shape")
  expect(capturedShape).toEqual({ kind: "none" })

  // C-u (plain)
  editor.prefixArg.universalArgument()
  await editor.run("test-raw-shape")
  expect(capturedShape).toEqual({ kind: "plain-cu", value: 4 })

  // Explicit digits
  editor.prefixArg.addDigit(7)
  await editor.run("test-raw-shape")
  expect(capturedShape).toEqual({ kind: "explicit", value: 7 })

  // Bare negative
  editor.prefixArg.toggleNegative()
  await editor.run("test-raw-shape")
  expect(capturedShape).toEqual({ kind: "bare-negative" })
})
