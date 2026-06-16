import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { BufferModel } from "../src/kernel/buffer"
import { emacsKeyDescription, isPrintable, keyToken, Keymap, KeymapStack } from "../src/kernel/keymap"
import { listWindowLeaves } from "../src/kernel/window"
import { Editor, LARGE_FILE_LITERAL_LOCAL } from "../src/kernel/editor"
import { buildDisplayModel } from "../src/display/build-display-model"
import { getTextScaleAmount, textScaleFactor } from "../src/core/text-scale"
import { installDefaultConfig as installDefaultCommands } from "../src/config"
import { install as installStephenConfig } from "./fixtures/stephen-config"
import { defaultTheme } from "../src/themes"
import { getCustom, resetCustom, setCustom } from "../src/runtime/custom"
import { pageScrollLines, visibleStyledText, visibleText } from "../src/ui/opentui"
import { diredEntryAtPoint } from "../src/modes/dired"
import { registerTreeSitterGrammars } from "../plugins/tree-sitter-grammars"

// Tree-sitter grammars are an opt-in plugin; register them for the font-lock
// assertions in this file (idempotent, synchronous).
registerTreeSitterGrammars()

test("buffer insert/delete/undo", () => {
  const b = new BufferModel({ name: "x", text: "abc" })
  b.point = 1
  b.insert("Z")
  expect(b.text).toBe("aZbc")
  b.deleteBackward()
  expect(b.text).toBe("abc")
  b.undo()
  expect(b.text).toBe("aZbc")
})

test("keymap handles multi-key command sequences", () => {
  const km = new Keymap()
  km.bind("C-x C-s", "save-buffer")
  const stack = new KeymapStack(() => [{ name: "global-map", keymap: km }])
  expect(stack.feed({ name: "x", ctrl: true }).status).toBe("pending")
  expect(stack.feed({ name: "s", ctrl: true })).toMatchObject({ status: "matched", command: "save-buffer" })
})

test("space key is printable", () => {
  expect(isPrintable({ name: "space", sequence: " " })).toBe(true)
  expect(isPrintable({ name: "space", sequence: " ", ctrl: true })).toBe(false)
})

test("tab key encodings map to Emacs-style window cycle bindings", () => {
  const editor = new Editor()
  installDefaultCommands(editor)

  expect(keyToken({ name: "tab", ctrl: true })).toBe("C-tab")
  expect(keyToken({ name: "backtab", ctrl: true })).toBe("C-S-tab")
  expect(keyToken({ name: "iso-lefttab", ctrl: true })).toBe("C-S-tab")
  expect(keyToken({ name: "tab", ctrl: true, shift: true })).toBe("C-S-tab")
  expect(keyToken({ name: "i", ctrl: true, sequence: "\t", raw: "\x1b\t" })).toBe("C-tab")
  expect(keyToken({ name: "tab", ctrl: true, raw: "\x1b[9;5u" })).toBe("C-tab")
  expect(keyToken({ name: "tab", ctrl: true, shift: true, raw: "\x1b[57346;6u" })).toBe("C-S-tab")

  expect(editor.keymap.get("C-tab")).toBe("other-window")
  expect(editor.keymap.get("C-S-tab")).toBe("previous-window-any-frame")
  expect(editor.commands.get("other-window-backward")).toBeUndefined()
  expect(editor.commands.get("jemacs-other-window-backward")).toBeDefined()

  const fed = editor.keymaps.feed({ name: "tab", ctrl: true })
  expect(fed.status).toBe("matched")
  if (fed.status === "matched") expect(fed.command).toBe("other-window")
})

test("key descriptions use Emacs spellings", () => {
  expect(emacsKeyDescription("enter")).toBe("RET")
  expect(emacsKeyDescription("space")).toBe("SPC")
  expect(emacsKeyDescription("backspace")).toBe("DEL")
  expect(emacsKeyDescription("tab")).toBe("TAB")
  expect(emacsKeyDescription("f1 k")).toBe("<f1> k")
  expect(emacsKeyDescription("C-x C-f")).toBe("C-x C-f")
})

test("mac option key sequences map to meta bindings", () => {
  expect(keyToken({ name: "≈", sequence: "≈" })).toBe("M-x")
  expect(keyToken({ name: "ƒ", sequence: "ƒ" })).toBe("M-f")
  expect(keyToken({ name: "∫", sequence: "∫" })).toBe("M-b")
  expect(keyToken({ name: "≥", sequence: "≥" })).toBe("M-.")
  expect(keyToken({ name: "≤", sequence: "≤" })).toBe("M-,")
  expect(isPrintable({ name: "≈", sequence: "≈" })).toBe(false)
  expect(isPrintable({ name: "≥", sequence: "≥" })).toBe(false)
})

test("visible text cursor does not shift the character under point", () => {
  expect(visibleText("abc", 1, 10)).toBe("a█c")
  expect(visibleText("abc", 3, 10)).toBe("abc█")
})

test("editor command registry runs commands", async () => {
  const editor = new Editor()
  editor.command("insert-hi", ({ buffer }) => buffer.insert("hi"))
  await editor.run("insert-hi")
  expect(editor.currentBuffer.text).toContain("hi")
})

test("editor messages return their text for eval feedback", async () => {
  const editor = new Editor()
  const evaluator = installDefaultCommands(editor)

  await expect(evaluator.evalExpression('editor.message("hello")')).resolves.toBe("hello")
  expect([...editor.buffers.values()].find(b => b.name === "*messages*")?.text).toContain("hello")
})

test("eval-last-sexp evaluates the expression before point", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const messages: string[] = []
  editor.events.on("message", ({ text }) => { messages.push(text) })
  editor.currentBuffer.setText("1 + 1;\nMath.max(4, 9)", false)
  editor.currentBuffer.point = editor.currentBuffer.text.length

  await editor.run("eval-last-sexp")

  expect(messages.at(-1)).toBe("Eval => 9")
})

test("eval-last-sexp reports user errors like eval-region", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  let echoed = ""
  editor.events.on("message", ({ text }) => { echoed = text })
  editor.currentBuffer.setText("1 + 1;\n(() => { throw new Error('sexp-boom') })()", false)
  editor.currentBuffer.point = editor.currentBuffer.text.length

  await editor.run("eval-last-sexp")

  expect(echoed).toBe("Eval error: sexp-boom")
  const backtrace = [...editor.buffers.values()].find(b => b.name === "*Backtrace*")
  expect(backtrace?.text).toContain("sexp-boom")
})

test("commands clear stale echo unless they replace it", async () => {
  const editor = new Editor()
  const messages: string[] = []
  editor.events.on("message", ({ text }) => { messages.push(text) })
  editor.command("noop", () => {})
  editor.command("say-new", ({ editor }) => { editor.message("new") })

  editor.message("old")
  await editor.run("noop")
  expect(messages.at(-1)).toBe("")

  editor.message("old")
  await editor.run("say-new")
  expect(messages.at(-1)).toBe("new")
})

test("buffer supports emacs-style movement primitives", () => {
  const b = new BufferModel({ name: "x", text: "one two\nthree" })
  b.point = 4
  b.moveWord(1)
  expect(b.point).toBe(7)
  b.moveWord(-1)
  expect(b.point).toBe(4)
  b.moveToLineEnd()
  expect(b.point).toBe(7)
  b.moveLine(1)
  expect(b.lineCol()).toEqual({ line: 2, col: 6 })
  b.moveToLineStart()
  expect(b.point).toBe(8)
})

test("C-v and M-v scroll by a page and are bound", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const page = pageScrollLines()
  const lines = Array.from({ length: page + 10 }, (_, i) => `line ${i + 1}`).join("\n")
  editor.currentBuffer.setText(lines, false)
  editor.currentBuffer.point = 0

  expect(editor.keymap.get("C-v")).toBe("scroll-up-command")
  expect(editor.keymap.get("M-v")).toBe("scroll-down-command")

  const step = page - 2
  await editor.run("scroll-up-command")
  expect(editor.currentBuffer.lineCol().line).toBe(step + 1)

  await editor.run("scroll-down-command")
  expect(editor.currentBuffer.lineCol().line).toBe(step + 1)

  editor.currentBuffer.point = 0
  expect(await editor.handleKey({ name: "v", ctrl: true })).toEqual({ status: "command", command: "scroll-up-command" })
  expect(editor.currentBuffer.lineCol().line).toBe(step + 1)

  expect(await editor.handleKey({ name: "v", meta: true })).toEqual({ status: "command", command: "scroll-down-command" })
  expect(editor.currentBuffer.lineCol().line).toBe(step + 1)
})

test("M-d kills the word after point and supports yank", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.currentBuffer.setText("one two three", false)
  editor.currentBuffer.point = 0

  expect(editor.keymap.get("M-d")).toBe("kill-word")
  await editor.run("kill-word")
  expect(editor.currentBuffer.text).toBe(" two three")
  expect(editor.currentBuffer.point).toBe(0)

  await editor.run("yank")
  expect(editor.currentBuffer.text).toBe("one two three")

  editor.currentBuffer.point = 4
  expect(await editor.handleKey({ name: "d", meta: true })).toEqual({ status: "command", command: "kill-word" })
  expect(editor.currentBuffer.text).toBe("one  three")
})

test("kill-line reports end of buffer only without an explicit prefix", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const messages: string[] = []
  editor.events.on("message", ({ text }) => { if (text) messages.push(text) })
  const buffer = editor.currentBuffer
  buffer.setText("abc", false)
  buffer.point = buffer.text.length

  await editor.run("kill-line")
  expect(buffer.text).toBe("abc")
  expect(buffer.point).toBe(3)
  expect(messages).toEqual(["End of buffer"])

  editor.prefixArg.addDigit(1)
  await editor.run("kill-line")
  expect(buffer.text).toBe("abc")
  expect(buffer.point).toBe(3)
  expect(messages).toEqual(["End of buffer"])
})

test("default emacs keybindings are registered and runnable", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.currentBuffer.setText("abc\ndef", false)
  editor.currentBuffer.point = 0

  expect(editor.keymaps.feed({ name: "f", ctrl: true })).toMatchObject({ status: "matched", command: "forward-char" })
  await editor.run("forward-char")
  expect(editor.currentBuffer.point).toBe(1)

  await editor.run("move-end-of-line")
  expect(editor.currentBuffer.point).toBe(3)
  await editor.run("kill-line")
  expect(editor.currentBuffer.text).toBe("abcdef")
  await editor.run("yank")
  expect(editor.currentBuffer.text).toBe("abc\ndef")

  expect(editor.keymaps.feed({ name: "x", ctrl: true }).status).toBe("pending")
  expect(editor.keymaps.feed({ name: "c", ctrl: true })).toMatchObject({ status: "matched", command: "save-buffers-kill-terminal" })
  expect(editor.keymaps.feed({ name: "≈", sequence: "≈" })).toMatchObject({ status: "matched", command: "execute-extended-command" })
  expect(editor.keymaps.feed({ name: "escape" }).status).toBe("pending")
  expect(editor.keymaps.feed({ name: "x" })).toMatchObject({ status: "matched", command: "execute-extended-command" })
})

test("forward-char and backward-char report Emacs boundary errors", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const messages: string[] = []
  editor.events.on("message", ({ text }) => { if (text) messages.push(text) })
  const buffer = editor.currentBuffer
  buffer.setText("ab", false)
  buffer.point = 1

  editor.prefixArg.addDigit(3)
  await editor.run("forward-char")
  expect(buffer.point).toBe(2)
  expect(messages.at(-1)).toBe("End of buffer")

  buffer.point = 1
  editor.prefixArg.addDigit(3)
  await editor.run("backward-char")
  expect(buffer.point).toBe(0)
  expect(messages.at(-1)).toBe("Beginning of buffer")
})

test("forward-char and backward-char honor negative prefixes at boundaries", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const messages: string[] = []
  editor.events.on("message", ({ text }) => { if (text) messages.push(text) })
  const buffer = editor.currentBuffer
  buffer.setText("ab", false)
  buffer.point = 1

  editor.prefixArg.toggleNegative()
  editor.prefixArg.addDigit(3)
  await editor.run("forward-char")
  expect(buffer.point).toBe(0)
  expect(messages.at(-1)).toBe("Beginning of buffer")

  buffer.point = 1
  editor.prefixArg.toggleNegative()
  editor.prefixArg.addDigit(3)
  await editor.run("backward-char")
  expect(buffer.point).toBe(2)
  expect(messages.at(-1)).toBe("End of buffer")
})

test("next-line and previous-line report Emacs boundary errors", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const messages: string[] = []
  editor.events.on("message", ({ text }) => { if (text) messages.push(text) })
  const buffer = editor.currentBuffer
  buffer.setText("a\nb\nc", false)
  buffer.point = 2

  editor.prefixArg.addDigit(3)
  await editor.run("next-line")
  expect(buffer.lineCol().line).toBe(3)
  expect(messages.at(-1)).toBe("End of buffer")

  buffer.point = 2
  editor.prefixArg.addDigit(3)
  await editor.run("previous-line")
  expect(buffer.lineCol().line).toBe(1)
  expect(messages.at(-1)).toBe("Beginning of buffer")
})

test("next-line and previous-line honor negative prefixes at boundaries", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const messages: string[] = []
  editor.events.on("message", ({ text }) => { if (text) messages.push(text) })
  const buffer = editor.currentBuffer
  buffer.setText("a\nb\nc", false)
  buffer.point = 2

  editor.prefixArg.toggleNegative()
  editor.prefixArg.addDigit(3)
  await editor.run("next-line")
  expect(buffer.lineCol().line).toBe(1)
  expect(messages.at(-1)).toBe("Beginning of buffer")

  buffer.point = 2
  editor.prefixArg.toggleNegative()
  editor.prefixArg.addDigit(3)
  await editor.run("previous-line")
  expect(buffer.lineCol().line).toBe(3)
  expect(messages.at(-1)).toBe("End of buffer")
})

test("move-end-of-line negative prefix stops at buffer start when it overshoots", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("aa\nbb\ncc\ndd", false)
  buffer.point = 6

  editor.prefixArg.toggleNegative()
  editor.prefixArg.addDigit(2)
  await editor.run("move-end-of-line")
  expect(buffer.point).toBe(0)
})

test("move-end-of-line zero prefix moves to previous line end", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("aa\nbb\ncc", false)
  buffer.point = 3

  editor.prefixArg.addDigit(0)
  await editor.run("move-end-of-line")
  expect(buffer.point).toBe(2)
})

test("forward-word and backward-word return false when reaching buffer edge", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("one two", false)
  buffer.point = 4

  expect(await editor.run("forward-word")).toBe(true)
  expect(buffer.point).toBe(7)

  buffer.point = 4
  editor.prefixArg.addDigit(3)
  expect(await editor.run("forward-word")).toBe(false)
  expect(buffer.point).toBe(7)

  buffer.point = 4
  expect(await editor.run("backward-word")).toBe(true)
  expect(buffer.point).toBe(0)

  buffer.point = 4
  editor.prefixArg.addDigit(3)
  expect(await editor.run("backward-word")).toBe(false)
  expect(buffer.point).toBe(0)
})

test("forward-word and backward-word preserve negative-prefix return semantics", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("one two", false)
  buffer.point = 4

  editor.prefixArg.toggleNegative()
  expect(await editor.run("forward-word")).toBe(true)
  expect(buffer.point).toBe(0)

  buffer.point = 4
  editor.prefixArg.toggleNegative()
  editor.prefixArg.addDigit(3)
  expect(await editor.run("backward-word")).toBe(false)
  expect(buffer.point).toBe(7)
})

test("goto-line uses numeric prefix and sets mark before moving", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("a\nb\nc\nd", false)
  buffer.point = 2

  editor.prefixArg.addDigit(3)
  await editor.run("goto-line")
  expect(buffer.point).toBe(4)
  expect(buffer.mark).toBe(2)
  expect(buffer.markActive).toBe(true)
})

test("goto-line clamps zero and negative prefixes to line one", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("a\nb\nc", false)
  buffer.point = buffer.text.length

  editor.prefixArg.addDigit(0)
  await editor.run("goto-line")
  expect(buffer.point).toBe(0)
  expect(buffer.mark).toBe(5)

  buffer.point = buffer.text.length
  editor.prefixArg.toggleNegative()
  await editor.run("goto-line")
  expect(buffer.point).toBe(0)
  expect(buffer.mark).toBe(5)
})

test("set-fill-column is the C-x f command and updates fill-column", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  resetCustom("fill-column")
  editor.currentBuffer.setText("abc\ndef", false)
  editor.currentBuffer.point = 5

  expect(getCustom<number>("fill-column")).toBe(70)
  expect(editor.commands.get("set-fill-column")?.interactive).toBe(true)
  expect(editor.keymap.get("C-x f")).toBe("set-fill-column")

  expect(await editor.run("set-fill-column")).toBe(1)
  expect(editor.currentBuffer.locals.get("fill-column")).toBe(1)
  expect(getCustom<number>("fill-column")).toBe(70)

  await editor.handleKey({ name: "u", ctrl: true })
  await editor.handleKey({ name: "1" })
  await editor.handleKey({ name: "2" })
  await editor.handleKey({ name: "x", ctrl: true })
  await editor.handleKey({ name: "f" })
  expect(editor.currentBuffer.locals.get("fill-column")).toBe(12)
  expect(getCustom<number>("fill-column")).toBe(70)
})

test("universal argument repeats motion, insertion, and deletion commands", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.currentBuffer.setText("abcdef", false)
  editor.currentBuffer.point = 0

  await editor.handleKey({ name: "u", ctrl: true })
  await editor.handleKey({ name: "f", ctrl: true })
  expect(editor.currentBuffer.point).toBe(4)

  await editor.handleKey({ name: "u", ctrl: true })
  await editor.handleKey({ name: "Z", sequence: "Z" })
  expect(editor.currentBuffer.text).toBe("abcdZZZZef")

  await editor.handleKey({ name: "u", ctrl: true })
  await editor.handleKey({ name: "backspace", meta: true })
  expect(editor.currentBuffer.text).toBe("ef")
})

test("self-insert-command with zero prefix inserts nothing", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.currentBuffer.setText("ab", false)
  editor.currentBuffer.point = 1

  editor.prefixArg.addDigit(0)
  await editor.handleKey({ name: "x", sequence: "x" })
  expect(editor.currentBuffer.text).toBe("ab")
  expect(editor.currentBuffer.point).toBe(1)
})

test("self-insert-command rejects negative prefix arguments", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const messages: string[] = []
  editor.events.on("message", ({ text }) => { messages.push(text) })
  editor.currentBuffer.setText("ab", false)
  editor.currentBuffer.point = 1

  editor.prefixArg.toggleNegative()
  await editor.handleKey({ name: "x", sequence: "x" })
  expect(editor.currentBuffer.text).toBe("ab")
  expect(editor.currentBuffer.point).toBe(1)
  expect(messages.at(-1)).toBe("Negative repetition argument -1")
})

test("quoted-insert inserts the next key literally and honors repeat prefixes", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("", false)

  await editor.handleKey({ name: "q", ctrl: true })
  await editor.handleKey({ name: "a", sequence: "a" })
  expect(buffer.text).toBe("a")

  await editor.handleKey({ name: "u", ctrl: true })
  await editor.handleKey({ name: "3", sequence: "3" })
  await editor.handleKey({ name: "q", ctrl: true })
  await editor.handleKey({ name: "b", sequence: "b" })
  expect(buffer.text).toBe("abbb")
})

test("quoted-insert consumes zero and negative repeat prefixes without inserting", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("x", false)
  buffer.point = 1

  await editor.handleKey({ name: "u", ctrl: true })
  await editor.handleKey({ name: "0", sequence: "0" })
  await editor.handleKey({ name: "q", ctrl: true })
  await editor.handleKey({ name: "a", sequence: "a" })
  expect(buffer.text).toBe("x")
  expect(editor.quotedInsertNext).toBe(false)

  await editor.handleKey({ name: "-", meta: true })
  await editor.handleKey({ name: "q", ctrl: true })
  await editor.handleKey({ name: "b", sequence: "b" })
  expect(buffer.text).toBe("x")
  expect(editor.quotedInsertNext).toBe(false)
})

test("quoted-insert bypasses keymaps for control characters", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("abc", false)
  buffer.point = buffer.text.length

  await editor.handleKey({ name: "q", ctrl: true })
  const result = await editor.handleKey({ name: "a", ctrl: true })
  expect(result).toEqual({ status: "command", command: "self-insert-command" })
  expect(buffer.text).toBe("abc\u0001")
  expect(buffer.point).toBe(4)
})

test("quoted-insert reads numeric character codes with GNU radix behavior", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("", false)

  await editor.handleKey({ name: "q", ctrl: true })
  await editor.handleKey({ name: "1", sequence: "1" })
  await editor.handleKey({ name: "0", sequence: "0" })
  await editor.handleKey({ name: "1", sequence: "1" })
  expect(buffer.text).toBe("A")
  expect(editor.quotedInsertNext).toBe(false)

  await editor.handleKey({ name: "q", ctrl: true })
  await editor.handleKey({ name: "1", sequence: "1" })
  await editor.handleKey({ name: "0", sequence: "0" })
  await editor.handleKey({ name: "1", sequence: "1" })
  await editor.handleKey({ name: "x", sequence: "x" })
  expect(buffer.text).toBe("AAx")

  await editor.handleKey({ name: "q", ctrl: true })
  await editor.handleKey({ name: "4", sequence: "4" })
  await editor.handleKey({ name: "0", sequence: "0" })
  await editor.handleKey({ name: "0", sequence: "0" })
  await editor.handleKey({ name: "enter" })
  expect(buffer.text).toBe("AAx\u0100")
})

test("quoted-insert honors read-quoted-char-radix", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("", false)

  try {
    setCustom("read-quoted-char-radix", 10)
    await editor.handleKey({ name: "q", ctrl: true })
    await editor.handleKey({ name: "6", sequence: "6" })
    await editor.handleKey({ name: "5", sequence: "5" })
    await editor.handleKey({ name: "enter" })
    expect(buffer.text).toBe("A")

    setCustom("read-quoted-char-radix", 16)
    await editor.handleKey({ name: "q", ctrl: true })
    await editor.handleKey({ name: "4", sequence: "4" })
    await editor.handleKey({ name: "1", sequence: "1" })
    await editor.handleKey({ name: "enter" })
    expect(buffer.text).toBe("AA")
  } finally {
    resetCustom("read-quoted-char-radix")
  }
})

test("default commands support buffer listing, switching, newline, and regions", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  const { getMode } = await import("../src/modes/mode")
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  await installStephenConfig(editor)
  editor.scratch("notes", "hello world", "text")

  await editor.run("switch-to-buffer", ["*scratch*"])
  expect(editor.currentBuffer.name).toBe("*scratch*")

  expect(editor.keymaps.feed({ name: "x", ctrl: true }).status).toBe("pending")
  expect(editor.keymaps.feed({ name: "b", ctrl: true })).toMatchObject({ status: "matched", command: "list-buffers" })
  await editor.run("list-buffers")
  expect(editor.currentBuffer.name).toBe("*Buffer List*")
  expect(editor.currentBuffer.mode).toBe("buffer-list")
  expect(editor.currentBuffer.readOnly).toBe(true)
  expect(editor.currentBuffer.text).toContain("notes")
  expect(getMode("buffer-list")?.keymap?.get("enter")).toBe("Buffer-menu-select")
  expect(editor.commands.get("buffer-list-select")).toBeUndefined()
  expect(editor.commands.get("Buffer-menu-select")).toBeDefined()

  const notesOffset = editor.currentBuffer.text.indexOf("notes")
  editor.currentBuffer.point = notesOffset
  await editor.run("Buffer-menu-select")
  expect(editor.currentBuffer.name).toBe("notes")

  await editor.run("list-buffers")
  expect(() => editor.currentBuffer.insert("x")).toThrow(/read-only/)

  await editor.run("switch-to-buffer", ["notes"])
  editor.currentBuffer.point = 5
  await editor.run("newline")
  expect(editor.currentBuffer.text).toBe("hello\n world")

  editor.currentBuffer.mark = 0
  editor.currentBuffer.point = 5
  await editor.run("kill-ring-save")
  editor.currentBuffer.point = editor.currentBuffer.text.length
  await editor.run("yank")
  expect(editor.currentBuffer.text.endsWith("hello")).toBe(true)

  editor.currentBuffer.mark = 0
  editor.currentBuffer.point = 5
  await editor.run("kill-region")
  expect(editor.currentBuffer.text.startsWith("\n world")).toBe(true)
})

test("list-buffers with prefix lists only file-visiting buffers", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.addBuffer(new BufferModel({ name: "file.txt", path: "/tmp/file.txt", text: "file" }))
  editor.scratch("notes", "scratch", "text")

  editor.prefixArg.addDigit(0)
  await editor.run("list-buffers")
  expect(editor.currentBuffer.name).toBe("*Buffer List*")
  expect(editor.currentBuffer.text).toContain("file.txt")
  expect(editor.currentBuffer.text).not.toContain("notes")
  expect(editor.currentBuffer.text).not.toContain("*scratch*")
})

test("newline honors numeric prefix arguments", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.currentBuffer.setText("ab", false)
  editor.currentBuffer.point = 1

  editor.prefixArg.addDigit(3)
  await editor.run("newline")
  expect(editor.currentBuffer.text).toBe("a\n\n\nb")
  expect(editor.currentBuffer.point).toBe(4)
})

test("newline with zero prefix is a no-op (Emacs: ARG newlines, 0 = none)", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.currentBuffer.setText("  ab", false)
  editor.currentBuffer.point = 3

  editor.prefixArg.addDigit(0)
  await editor.run("newline")
  expect(editor.currentBuffer.text).toBe("  ab")
  expect(editor.currentBuffer.point).toBe(3)
})

test("newline rejects negative prefix arguments", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const messages: string[] = []
  editor.events.on("message", ({ text }) => { messages.push(text) })
  editor.currentBuffer.setText("ab", false)
  editor.currentBuffer.point = 1

  editor.prefixArg.toggleNegative()
  await editor.run("newline")
  expect(editor.currentBuffer.text).toBe("ab")
  expect(editor.currentBuffer.point).toBe(1)
  expect(messages.at(-1)).toBe("Repetition argument has to be non-negative")
})

test("open-line honors positive prefix arguments and preserves point", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.currentBuffer.setText("abc", false)
  editor.currentBuffer.point = 1

  editor.prefixArg.addDigit(3)
  await editor.run("open-line")

  expect(editor.currentBuffer.text).toBe("a\n\n\nbc")
  expect(editor.currentBuffer.point).toBe(1)
})

test("open-line rejects negative prefix arguments", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  let echoed = ""
  editor.events.on("message", ({ text }) => { echoed = text })
  editor.currentBuffer.setText("abc", false)
  editor.currentBuffer.point = 1

  editor.prefixArg.toggleNegative()
  await editor.run("open-line")

  expect(editor.currentBuffer.text).toBe("abc")
  expect(editor.currentBuffer.point).toBe(1)
  expect(echoed).toBe("Repetition argument has to be non-negative")
})

test("transpose-chars honors positive and negative prefix arguments", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("abcdef", false)
  buffer.point = 2

  editor.prefixArg.addDigit(3)
  await editor.run("transpose-chars")
  expect(buffer.text).toBe("acdebf")
  expect(buffer.point).toBe(5)

  buffer.setText("abcdef", false)
  buffer.point = 3
  editor.prefixArg.toggleNegative()
  editor.prefixArg.addDigit(2)
  await editor.run("transpose-chars")
  expect(buffer.text).toBe("cabdef")
  expect(buffer.point).toBe(1)
})

test("transpose-chars reports Emacs boundary errors", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const messages: string[] = []
  editor.events.on("message", ({ text }) => { if (text) messages.push(text) })
  const buffer = editor.currentBuffer

  buffer.setText("abc", false)
  buffer.point = 0
  await editor.run("transpose-chars")
  expect(messages.at(-1)).toBe("Beginning of buffer")

  buffer.point = buffer.text.length
  editor.prefixArg.addDigit(1)
  await editor.run("transpose-chars")
  expect(messages.at(-1)).toBe("End of buffer")
})

test("kill-region and kill-ring-save require a mark like Emacs", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.currentBuffer.setText("hello\nworld", false)
  let message = ""
  editor.events.on("message", ({ text }) => { message = text })

  await editor.run("kill-region")
  expect(editor.currentBuffer.text).toBe("hello\nworld")
  expect(message).toContain("The mark is not set now")

  message = ""
  await editor.run("kill-ring-save")
  expect(editor.currentBuffer.text).toBe("hello\nworld")
  expect(message).toContain("The mark is not set now")
})

test("clipboard kill commands use Emacs names and region semantics", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("hello world", false)

  expect(editor.commands.get("clipboard-kill-ring-save")).toBeDefined()
  expect(editor.commands.get("clipboard-kill-region")).toBeDefined()
  expect(editor.commands.get("clipboard-yank")).toBeDefined()
  expect(editor.commands.get("copy-region-to-clipboard-mac")).toBeUndefined()
  expect(editor.commands.get("jemacs-copy-region-to-clipboard-mac")).toBeDefined()

  buffer.mark = 0
  buffer.markActive = true
  buffer.point = 5
  await editor.run("clipboard-kill-ring-save")
  expect(buffer.text).toBe("hello world")
  expect(buffer.mark).toBe(0)
  expect(buffer.markActive).toBe(false)

  buffer.point = buffer.text.length
  await editor.run("yank")
  expect(buffer.text).toBe("hello worldhello")

  buffer.point = buffer.text.length
  await editor.run("clipboard-yank")
  expect(buffer.text.endsWith("hellohello")).toBe(true)
  expect(buffer.mark).toBe(buffer.text.length - 5)
  expect(buffer.markActive).toBe(false)

  buffer.mark = 0
  buffer.markActive = true
  buffer.point = 5
  await editor.run("clipboard-kill-region")
  expect(buffer.text).toBe(" worldhellohello")
  expect(buffer.mark).toBeNull()

  buffer.point = 0
  await editor.run("yank")
  expect(buffer.text).toBe("hello worldhellohello")
})

test("kill-ring-save deactivates mark and yank marks inserted text like Emacs", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("hello world", false)
  buffer.mark = 0
  buffer.markActive = true
  buffer.point = 5

  await editor.run("kill-ring-save")
  expect(buffer.text).toBe("hello world")
  expect(buffer.mark).toBe(0)
  expect(buffer.markActive).toBe(false)

  buffer.point = buffer.text.length
  await editor.run("yank")
  expect(buffer.text).toBe("hello worldhello")
  expect(buffer.mark).toBe("hello world".length)
  expect(buffer.markActive).toBe(false)

  await editor.run("exchange-point-and-mark")
  expect(buffer.markActive).toBe(true)
  expect(buffer.selectedText()).toBe("hello")
})

test("yank honors numeric, zero, and negative prefix arguments", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  const pushKill = async (text: string) => {
    buffer.setText(text, false)
    buffer.mark = 0
    buffer.markActive = true
    buffer.point = text.length
    await editor.run("kill-region")
  }
  await pushKill("older")
  await pushKill("old")
  await pushKill("new")

  buffer.setText("", false)
  buffer.point = 0
  editor.prefixArg.addDigit(2)
  await editor.run("yank")
  expect(buffer.text).toBe("old")

  buffer.setText("", false)
  buffer.point = 0
  editor.prefixArg.addDigit(0)
  await editor.run("yank")
  expect(buffer.text).toBe("older")

  buffer.setText("", false)
  buffer.point = 0
  editor.prefixArg.toggleNegative()
  editor.prefixArg.addDigit(1)
  await editor.run("yank")
  expect(buffer.text).toBe("old")
})

test("yank-pop continues from a prefixed yank ring position", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  const pushKill = async (text: string) => {
    buffer.setText(text, false)
    buffer.mark = 0
    buffer.markActive = true
    buffer.point = text.length
    await editor.run("kill-region")
  }
  await pushKill("older")
  await pushKill("old")
  await pushKill("new")

  buffer.setText("", false)
  buffer.point = 0
  editor.prefixArg.addDigit(2)
  await editor.run("yank")
  expect(buffer.text).toBe("old")

  await editor.run("yank-pop")
  expect(buffer.text).toBe("older")
})

test("yank-pop honors numeric and negative prefix arguments", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  const pushKill = async (text: string) => {
    buffer.setText(text, false)
    buffer.mark = 0
    buffer.markActive = true
    buffer.point = text.length
    await editor.run("kill-region")
  }
  await pushKill("older")
  await pushKill("old")
  await pushKill("new")

  buffer.setText("", false)
  buffer.point = 0
  await editor.run("yank")
  expect(buffer.text).toBe("new")

  editor.prefixArg.addDigit(2)
  await editor.run("yank-pop")
  expect(buffer.text).toBe("older")

  editor.prefixArg.toggleNegative()
  editor.prefixArg.addDigit(1)
  await editor.run("yank-pop")
  expect(buffer.text).toBe("old")
})

test("yank-pop does not replace a stale yank after another command", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const messages: string[] = []
  editor.events.on("message", ({ text }) => { if (text) messages.push(text) })
  const buffer = editor.currentBuffer
  buffer.setText("old", false)
  buffer.mark = 0
  buffer.markActive = true
  buffer.point = 3
  await editor.run("kill-region")
  buffer.setText("new", false)
  buffer.mark = 0
  buffer.markActive = true
  buffer.point = 3
  await editor.run("kill-region")

  buffer.setText("", false)
  buffer.point = 0
  await editor.run("yank")
  expect(buffer.text).toBe("new")

  await editor.run("backward-char")
  await editor.run("yank-pop")
  expect(buffer.text).toBe("new")
  expect(messages.at(-1)).toBe("Previous command was not a yank")
})

test("downcase-region converts region text and preserves point and mark", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("AbC DeF", false)
  buffer.point = 1
  buffer.mark = 5
  buffer.markActive = true

  await editor.run("downcase-region")

  expect(buffer.text).toBe("Abc deF")
  expect(buffer.point).toBe(1)
  expect(buffer.mark).toBe(5)
  expect(buffer.markActive).toBe(true)
})

test("help keybindings keep C-h as a prefix", () => {
  const editor = new Editor()
  installDefaultCommands(editor)

  expect(editor.keymaps.feed({ name: "h", ctrl: true }).status).toBe("pending")
  expect(editor.keymaps.feed({ name: "k" })).toMatchObject({ status: "matched", command: "describe-key" })
  expect(editor.keymaps.feed({ name: "backspace", sequence: "\x08", raw: "\x08" }).status).toBe("pending")
  expect(editor.keymaps.feed({ name: "k" })).toMatchObject({ status: "matched", command: "describe-key" })
  expect(editor.keymaps.feed({ name: "backspace", sequence: "\x7f", raw: "\x7f" })).toMatchObject({ status: "matched", command: "delete-backward-char" })
  expect(editor.keymap.get("C-h c")).toBe("describe-key-briefly")
  expect(editor.keymap.get("C-h m")).toBe("describe-mode")
  expect(editor.keymap.get("C-h b")).toBe("describe-bindings")
})

test("C-c C-r uses revert-buffer", () => {
  const editor = new Editor()
  installDefaultCommands(editor)

  expect(editor.keymaps.feed({ name: "c", ctrl: true }).status).toBe("pending")
  expect(editor.keymaps.feed({ name: "r", ctrl: true })).toMatchObject({ status: "matched", command: "revert-buffer" })
})

test("kernel handles printable, command, prefix, and minibuffer keys through one dispatcher", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.currentBuffer.setText("", false)

  await editor.handleKey({ name: "a", sequence: "a" })
  expect(editor.currentBuffer.text).toBe("a")

  expect(await editor.handleKey({ name: "x", ctrl: true })).toEqual({ status: "pending" })
  expect(await editor.handleKey({ name: "b", ctrl: true })).toEqual({ status: "command", command: "list-buffers" })
  expect(editor.currentBuffer.name).toBe("*Buffer List*")

  const prompt = editor.completingRead("Switch to buffer: ", { collection: [...editor.buffers.values()].map(b => b.name), history: "buffer", initialValue: "" })
  expect(editor.minibuffer?.prompt).toBe("Switch to buffer: ")
  await editor.handleKey({ name: "*", sequence: "*" })
  await editor.handleKey({ name: "m", sequence: "m" })
  await editor.handleKey({ name: "tab" })
  expect(editor.activeBuffer.text).toBe("*messages*")
  await editor.handleKey({ name: "return" })
  await expect(prompt).resolves.toBe("*messages*")
  expect(editor.minibuffer).toBeNull()
})

test("minibuffer keeps global bindings active and supports C-g cancellation", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const prompt = editor.prompt("Nested: ")

  expect(editor.minibuffer).not.toBeNull()
  await editor.handleKey({ name: "g", ctrl: true })
  await expect(prompt).resolves.toBeNull()
  expect(editor.minibuffer).toBeNull()
})

test("C-s is bound to isearch-forward", () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  expect(editor.keymap.get("C-s")).toBe("isearch-forward")
})

test("incremental search moves point as the query grows", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.currentBuffer.setText("foo bar foo", false)
  editor.currentBuffer.point = 0

  await editor.run("isearch-forward")
  expect(editor.isearch?.direction).toBe(1)

  await editor.handleKey({ name: "f", sequence: "f" })
  expect(editor.currentBuffer.point).toBe(1)
  const afterF = visibleStyledText(editor.currentBuffer.text, editor.currentBuffer.point, {
    spans: [{ start: 0, end: 1, face: "isearch" }],
    theme: editor.theme,
  })
  expect(afterF.chunks.some(chunk => chunk.bg != null)).toBe(true)

  await editor.handleKey({ name: "o", sequence: "o" })
  expect(editor.currentBuffer.point).toBe(2)

  await editor.run("isearch-forward")
  expect(editor.currentBuffer.point).toBe(10)

  await editor.run("keyboard-quit")
  expect(editor.isearch).toBeNull()
  expect(editor.currentBuffer.point).toBe(0)
})

test("isearch enter exits and clears stale prompt echo", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  let lastMessage = ""
  editor.events.on("message", ({ text }) => { lastMessage = text })
  editor.currentBuffer.setText("foo bar foo", false)

  await editor.run("isearch-forward")
  await editor.handleKey({ name: "f", sequence: "f" })
  expect(lastMessage).toContain("I-search")

  await editor.handleKey({ name: "enter", sequence: "\r" })
  expect(editor.isearch).toBeNull()
  expect(lastMessage).toBe("")
})

test("find-file prompt defaults to dired buffer directory", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  await installStephenConfig(editor)
  const dired = await editor.openDirectory("/tmp")
  expect(dired.directory()).toBe("/tmp")

  const prompt = editor.completingRead("Find file: ", {
    completion: "file",
    history: "file",
    initialValue: editor.currentBuffer.directory() ?? process.cwd(),
  })
  expect(editor.activeBuffer.text).toBe("/tmp")
  editor.minibufferCancel()
  await prompt
})

test("find-file prompt defaults to cwd when buffer has no directory", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const prompt = editor.completingRead("Find file: ", {
    completion: "file",
    history: "file",
    initialValue: editor.currentBuffer.directory() ?? process.cwd(),
  })
  expect(editor.activeBuffer.text).toBe(process.cwd())
  editor.minibufferCancel()
  await prompt
})

test("find-file command starts minibuffer at cwd slash", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const prompt = editor.run("find-file")
  expect(editor.activeBuffer.text).toBe(`${process.cwd()}/`)
  editor.minibufferCancel()
  await prompt
})

test("find-file-read-only opens a file with buffer read-only", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const file = "/tmp/jemacs-find-file-read-only.txt"
  await Bun.write(file, "read only")

  await editor.run("find-file-read-only", [file])

  expect(editor.currentBuffer.path).toBe(file)
  expect(editor.currentBuffer.text).toBe("read only")
  expect(editor.currentBuffer.readOnly).toBe(true)
})

test("find-file minibuffer supports readline bindings like C-a", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const initial = "/tmp/example/path"
  const prompt = editor.completingRead("Find file: ", {
    completion: "file",
    history: "file",
    initialValue: initial,
  })
  expect(editor.activeBuffer.point).toBe(initial.length)

  await editor.handleKey({ name: "a", ctrl: true })
  expect(editor.activeBuffer.point).toBe(0)

  await editor.handleKey({ name: "e", ctrl: true })
  expect(editor.activeBuffer.point).toBe(initial.length)

  editor.minibufferCancel()
  await prompt
})

test("minibuffer ignores major mode keymaps from the edited buffer", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  await editor.openDirectory(process.cwd())

  const prompt = editor.completingRead("Find file: ", {
    completion: "file",
    history: "file",
    initialValue: "/tmp/example",
  })
  await editor.handleKey({ name: "e", ctrl: true })
  const lengthBefore = editor.activeBuffer.text.length
  await editor.handleKey({ name: "backspace" })
  expect(editor.activeBuffer.text.length).toBe(lengthBefore - 1)

  editor.minibufferCancel()
  await prompt
})

test("describe-key in minibuffer reports global binding for C-a", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.completingRead("Find file: ", { completion: "file", initialValue: "/tmp" })
  expect(editor.describeKey("C-a")).toContain("runs the command move-beginning-of-line (found in global-map)")
  editor.minibufferCancel()
})

test("describe-key reports the winning keymap and command", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)

  expect(editor.describeKey("C-x C-f")).toContain("runs the command find-file (found in global-map)")
  await editor.run("describe-key", ["C-x", "C-f"])
  expect(editor.currentBuffer.name).toBe("*Help*")
  expect(editor.currentBuffer.text).toContain("C-x C-f runs the command find-file (found in global-map)")
})

test("read-key-sequence returns Emacs key descriptions", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)

  const read = editor.readKeySequence("Key: ")
  await editor.handleKey({ name: "enter" })
  await expect(read).resolves.toBe("RET")
})

test("read-key-sequence echoes Emacs descriptions for prefixes", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  let echoed = ""
  editor.events.on("message", ({ text }) => { echoed = text })

  const read = editor.readKeySequence("Key: ")
  await editor.handleKey({ name: "x", ctrl: true })
  expect(echoed).toBe("Key: C-x")
  await editor.handleKey({ name: "f", ctrl: true })
  await expect(read).resolves.toBe("C-x C-f")
})

test("describe-key captures a real key sequence instead of dispatching it", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)

  const describe = editor.run("describe-key")
  await editor.handleKey({ name: "x", ctrl: true })
  expect(editor.currentBuffer.name).not.toBe("*Buffer List*")
  await editor.handleKey({ name: "f", ctrl: true })
  await describe

  expect(editor.currentBuffer.name).toBe("*Help*")
  expect(editor.currentBuffer.text).toContain("C-x C-f runs the command find-file (found in global-map)")
})

test("describe-key-briefly reads a full key sequence", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  let echoed = ""
  editor.events.on("message", ({ text }) => { echoed = text })

  const describe = editor.run("describe-key-briefly")
  await editor.handleKey({ name: "x", ctrl: true })
  await editor.handleKey({ name: "f", ctrl: true })
  await describe

  expect(echoed).toBe("C-x C-f runs the command find-file")
})

test("my/bind-key uses Emacs key descriptions in the command prompt", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  await installStephenConfig(editor)
  let prompt = ""
  editor.completingReadFunction = async (_editor, p) => {
    prompt = p
    return "goto-line"
  }

  const bind = editor.run("my/bind-key")
  await editor.handleKey({ name: "c", ctrl: true })
  await editor.handleKey({ name: "9" })
  await bind

  expect(prompt).toBe("Command to bind to 'C-c 9': ")
  expect(editor.keymap.get("C-c 9")).toBe("goto-line")
})

test("keymap stack gives minibuffer bindings precedence over global bindings", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.key("tab", "save-buffers-kill-terminal")
  const prompt = editor.completingRead("M-x ", { collection: ["replace-string", "revert-buffer"], history: "command", initialValue: "r" })

  await editor.handleKey({ name: "tab" })
  expect(editor.running).toBe(true)
  expect(editor.minibufferCompletionDisplay?.text).toContain("revert-buffer")
  await editor.handleKey({ name: "g", ctrl: true })
  await prompt
})

test("prog-mode and python-mode are installed with a real python major map", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  const { getMode, modeLineage } = await import("../src/modes/mode")
  installDefaultModes()

  expect(getMode("prog-mode")?.keymap?.all()).toEqual([])
  expect(getMode("python")?.parent).toBe("prog-mode")
  expect(getMode("python")?.keymap?.get("C-M-a")).toBe("beginning-of-defun")
  expect(getMode("python")?.keymap?.get("C-M-e")).toBe("end-of-defun")
  expect(modeLineage("python").map(m => m.name)).toEqual(["python", "prog-mode", "text"])

  const editor = new Editor()
  const file = await editor.openFile("/tmp/jemacs-goal-test.py")
  expect(file.mode).toBe("python")
})

test("sh-mode, shell-script-mode, and bash-mode are installed as core shell script modes", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  const { getMode, modeFeature, modeLineage } = await import("../src/modes/mode")
  installDefaultModes()

  expect(getMode("sh-mode")?.parent).toBe("prog-mode")
  expect(getMode("sh-mode")?.commentStart).toBe("#")
  expect(getMode("sh-mode")?.keymap?.get("C-M-a")).toBe("beginning-of-defun")
  expect(modeFeature("sh-mode", "beginningOfDefun")).toBeDefined()
  expect(modeFeature("sh-mode", "endOfDefun")).toBeDefined()
  expect(getMode("shell-script-mode")?.parent).toBe("sh-mode")
  expect(getMode("bash-mode")?.parent).toBe("sh-mode")
  expect(modeLineage("bash-mode").map(m => m.name)).toEqual(["bash-mode", "sh-mode", "prog-mode", "text"])

  expect(new BufferModel({ name: "deploy.sh" }).mode).toBe("sh-mode")
  expect(new BufferModel({ name: ".zshrc", path: "/tmp/.zshrc" }).mode).toBe("sh-mode")
  expect(new BufferModel({ name: "script", text: "#!/bin/sh\necho hi\n" }).mode).toBe("sh-mode")

  await Bun.write("/tmp/jemacs-shell-script-without-extension", "#!/usr/bin/env bash\necho hi\n")
  const editor = new Editor()
  const file = await editor.openFile("/tmp/jemacs-shell-script-without-extension")
  expect(file.mode).toBe("sh-mode")
})

test("sh-mode supports indentation, font-lock, and TAB completion", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.scratch("example.sh", "greet() {\nif true; then\necho \"hi\"\nfi\n}\nex", "sh-mode")

  buffer.point = buffer.text.indexOf("if true")
  editor.indentLine(buffer)
  expect(buffer.text).toContain("greet() {\n  if true; then")

  buffer.point = buffer.text.indexOf("echo")
  editor.indentLine(buffer)
  expect(buffer.text).toContain("  if true; then\n    echo \"hi\"")

  buffer.point = buffer.text.indexOf("fi")
  editor.indentLine(buffer)
  expect(buffer.text).toContain("    echo \"hi\"\n  fi")

  const spans = editor.fontLock(buffer)
  expect(spans.some(span => span.face === "keyword" && buffer.text.slice(span.start, span.end) === "if")).toBe(true)
  expect(spans.some(span => span.face === "builtin" && buffer.text.slice(span.start, span.end) === "echo")).toBe(true)
  expect(spans.some(span => span.face === "function" && buffer.text.slice(span.start, span.end) === "greet")).toBe(true)
  expect(spans.some(span => span.face === "string" && buffer.text.slice(span.start, span.end) === "\"hi\"")).toBe(true)

  buffer.point = buffer.text.length
  await editor.completeAtPoint(buffer)
  expect(buffer.text.endsWith("exec")).toBe(true)
})

test("sh-mode supports generic defun navigation through mode features", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.scratch("example.sh", "greet() {\n  echo hi\n}\n\nbye() {\n  echo bye\n}\n", "sh-mode")

  buffer.point = buffer.text.indexOf("echo bye")
  await editor.run("beginning-of-defun")
  expect(buffer.point).toBe(buffer.text.indexOf("bye()"))
  await editor.run("end-of-defun")
  expect(buffer.point).toBe(buffer.text.lastIndexOf("}") + 1)
})

test("emacs-lisp-mode is installed for .el files using GNU Emacs naming", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  const { getMode, modeFeature, modeLineage } = await import("../src/modes/mode")
  installDefaultModes()

  expect(getMode("emacs-lisp-mode")?.parent).toBe("prog-mode")
  expect(getMode("emacs-lisp-mode")?.commentStart).toBe(";")
  expect(getMode("emacs-lisp-mode")?.keymap?.get("C-M-a")).toBe("beginning-of-defun")
  expect(getMode("emacs-lisp-mode")?.keymap?.get("C-M-e")).toBe("end-of-defun")
  expect(modeFeature("emacs-lisp-mode", "beginningOfDefun")).toBeDefined()
  expect(modeFeature("emacs-lisp-mode", "endOfDefun")).toBeDefined()
  expect(modeLineage("emacs-lisp-mode").map(m => m.name)).toEqual(["emacs-lisp-mode", "prog-mode", "text"])
  expect(new BufferModel({ name: "init.el" }).mode).toBe("emacs-lisp-mode")
})

test("emacs-lisp-mode supports indentation, defun navigation, font-lock, and TAB completion", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.scratch("example.el", "(defun greet ()\n(message \"hi\"))\n(setq local-value mes", "emacs-lisp-mode")

  buffer.point = buffer.text.indexOf("(message")
  editor.indentLine(buffer)
  expect(buffer.text).toContain("(defun greet ()\n  (message \"hi\")")

  buffer.point = buffer.text.length
  await editor.run("beginning-of-defun")
  expect(buffer.point).toBe(0)
  await editor.run("end-of-defun")
  expect(buffer.point).toBe(buffer.text.lastIndexOf(")") + 1)

  const spans = editor.fontLock(buffer)
  expect(spans.some(span => span.face === "keyword" && buffer.text.slice(span.start, span.end) === "defun")).toBe(true)
  expect(spans.some(span => span.face === "function" && buffer.text.slice(span.start, span.end) === "greet")).toBe(true)
  expect(spans.some(span => span.face === "builtin" && buffer.text.slice(span.start, span.end) === "message")).toBe(true)
  expect(spans.some(span => span.face === "string" && buffer.text.slice(span.start, span.end) === "\"hi\"")).toBe(true)

  buffer.point = buffer.text.length
  await editor.completeAtPoint(buffer)
  expect(buffer.text.endsWith("message")).toBe(true)
})

test("python mode supports indentation, defun navigation, font-lock, and TAB completion", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  const { modeFeature } = await import("../src/modes/mode")
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  await installStephenConfig(editor)
  const buffer = editor.scratch("example.py", "def outer():\nprint('hi')\n    return ran", "python")
  expect(modeFeature("python", "beginningOfDefun")).toBeDefined()
  expect(modeFeature("python", "endOfDefun")).toBeDefined()

  buffer.point = buffer.text.indexOf("print")
  editor.indentLine(buffer)
  expect(buffer.text).toContain("def outer():\n    print('hi')")

  buffer.point = buffer.text.indexOf("return")
  editor.indentLine(buffer)
  expect(buffer.text).toContain("    return ran")

  buffer.point = buffer.text.length
  await editor.run("beginning-of-defun")
  expect(buffer.point).toBe(0)
  await editor.run("end-of-defun")
  expect(buffer.point).toBe(buffer.text.length)
  expect(editor.commands.get("python-beginning-of-defun")).toBeUndefined()
  expect(editor.commands.get("python-end-of-defun")).toBeUndefined()
  expect(editor.commands.get("jemacs-python-beginning-of-defun")).toBeDefined()
  expect(editor.commands.get("jemacs-python-end-of-defun")).toBeDefined()
  expect(editor.commands.get("redo")).toBeUndefined()
  expect(editor.commands.get("jemacs-redo")).toBeDefined()

  const spans = editor.fontLock(buffer)
  expect(spans.some(span => span.face === "keyword" && buffer.text.slice(span.start, span.end) === "def")).toBe(true)
  expect(spans.some(span => span.face === "function" && buffer.text.slice(span.start, span.end) === "outer")).toBe(true)
  expect(spans.some(span => span.face === "string" && buffer.text.slice(span.start, span.end) === "'hi'")).toBe(true)
})

test("tree-sitter font-lock highlights javascript, html, and java modes", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  const { install: installTreeSitterGrammars } = await import("../plugins/tree-sitter-grammars")
  installDefaultModes()
  const editor = new Editor()
  await installTreeSitterGrammars(editor)

  const js = editor.scratch("app.js", "function greet() { return 'hi' }\n", "javascript")
  const jsSpans = editor.fontLock(js)
  expect(jsSpans.some(span => js.text.slice(span.start, span.end) === "function" && span.face === "keyword")).toBe(true)
  expect(jsSpans.some(span => js.text.slice(span.start, span.end) === "greet" && span.face === "function")).toBe(true)

  const html = editor.scratch("page.html", "<div class=\"x\">text</div>\n", "html")
  const htmlSpans = editor.fontLock(html)
  expect(htmlSpans.some(span => html.text.slice(span.start, span.end) === "div" && span.face === "keyword")).toBe(true)
  expect(htmlSpans.some(span => html.text.slice(span.start, span.end) === "class" && span.face === "type")).toBe(true)

  const java = editor.scratch("Main.java", "public class Main { void run() {} }\n", "java")
  const javaSpans = editor.fontLock(java)
  expect(javaSpans.some(span => java.text.slice(span.start, span.end) === "public" && span.face === "keyword")).toBe(true)
  expect(javaSpans.some(span => java.text.slice(span.start, span.end) === "Main" && span.face === "type")).toBe(true)
  expect(javaSpans.some(span => java.text.slice(span.start, span.end) === "run" && span.face === "function")).toBe(true)
})

test("dired opens directories, follows entries, refreshes, and exposes dired keymap", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  const { getMode } = await import("../src/modes/mode")
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  await installStephenConfig(editor)
  await Bun.write("/tmp/jemacs-dired-file.txt", "hello")

  const buffer = await editor.openDirectory("/tmp")
  expect(buffer.kind).toBe("directory")
  expect(buffer.mode).toBe("dired")
  expect(buffer.readOnly).toBe(true)
  expect(buffer.text).toContain("Directory /tmp")
  expect(buffer.text).toContain("jemacs-dired-file.txt")
  expect(getMode("dired")?.keymap?.get("enter")).toBe("dired-find-file")

  buffer.point = buffer.text.indexOf("jemacs-dired-file.txt")
  await editor.run("dired-find-file")
  expect(editor.currentBuffer.name).toBe("jemacs-dired-file.txt")
  expect(editor.currentBuffer.text).toBe("hello")

  await editor.run("dired", ["/tmp"])
  await editor.run("revert-buffer")
  expect(editor.currentBuffer.text).toContain("jemacs-dired-file.txt")

  const cwd = process.cwd()
  await mkdir("/tmp/jemacs-dired-dot-test", { recursive: true })
  await Bun.write("/tmp/jemacs-dired-dot-test/inside.txt", "dot")
  try {
    process.chdir("/tmp/jemacs-dired-dot-test")
    await editor.openFile(".")
    expect(editor.currentBuffer.kind).toBe("directory")
    expect(editor.currentBuffer.mode).toBe("dired")
    expect(editor.currentBuffer.readOnly).toBe(true)
    expect(editor.currentBuffer.text).toContain("inside.txt")
  } finally {
    process.chdir(cwd)
  }
})

test("dired .. opens the parent directory", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  const nested = "/tmp/jemacs-dired-nested"
  await mkdir(nested, { recursive: true })
  const buffer = await editor.openDirectory(nested)
  buffer.point = buffer.text.indexOf("..")
  await editor.run("dired-find-file")
  expect(editor.currentBuffer.path).toBe("/tmp")
})

test("dired-jump opens the current file directory and moves to the file line", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  const dir = "/tmp/jemacs-dired-jump-test"
  const file = `${dir}/target.txt`
  await mkdir(dir, { recursive: true })
  await Bun.write(file, "jump")
  await editor.openFile(file)

  await editor.run("dired-jump")

  expect(editor.currentBuffer.kind).toBe("directory")
  expect(editor.currentBuffer.path).toBe(dir)
  expect(diredEntryAtPoint(editor.currentBuffer)?.path).toBe(file)
})

test("c-mode and json-mode font-lock highlight keywords and strings", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()

  const c = editor.scratch("main.c", "int main() { return 0; }\n", "c")
  const cSpans = editor.fontLock(c)
  expect(cSpans.some(span => c.text.slice(span.start, span.end) === "int" && span.face === "keyword")).toBe(true)
  expect(cSpans.some(span => c.text.slice(span.start, span.end) === "return" && span.face === "keyword")).toBe(true)

  const json = editor.scratch("data.json", '{ "ok": true, "msg": "hi" }\n', "json")
  const jsonSpans = editor.fontLock(json)
  expect(jsonSpans.some(span => json.text.slice(span.start, span.end) === "true" && span.face === "keyword")).toBe(true)
  expect(jsonSpans.some(span => json.text.slice(span.start, span.end) === '"hi"' && span.face === "string")).toBe(true)
})

test("font-lock cache stays stable when only point moves", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()
  const buffer = editor.scratch("stable.js", "const value = 1\n", "javascript")
  const first = editor.fontLock(buffer)
  buffer.point = buffer.text.length
  const second = editor.fontLock(buffer)
  expect(second).toEqual(first)
})

test("font-lock can be requested for a visible range", async () => {
  const { defineMode } = await import("../src/modes/mode")
  const editor = new Editor()
  const calls: Array<{ start: number; end: number } | undefined> = []
  defineMode({
    name: "range-font-lock",
    fontLock: (_buffer, range) => {
      calls.push(range ? { start: range.start, end: range.end } : undefined)
      return range ? [{ start: range.start, end: range.start + 1, face: "keyword" }] : []
    },
  })
  const buffer = editor.scratch("range.txt", "a\nb\nc\n", "range-font-lock")

  const spans = editor.fontLock(buffer, { startLine: 1, endLine: 2, start: 2, end: 4 })

  expect(calls).toEqual([{ start: 2, end: 4 }])
  expect(spans).toEqual([{ start: 2, end: 3, face: "keyword" }])
})

test("large files open literally and can return to normal mode", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  setCustom("large-file-warning-threshold", 16)
  const path = "/tmp/jemacs-large-literal.py"
  await Bun.write(path, "def f():\n    return 'loaded'\n")
  try {
    const buffer = await editor.openFile(path)
    expect(buffer.mode).toBe("text")
    expect(buffer.locals.get(LARGE_FILE_LITERAL_LOCAL)).toBe(true)

    for (let i = 0; i < 50 && buffer.text === ""; i++) await Bun.sleep(10)
    expect(buffer.text).toContain("loaded")
    expect(buffer.dirty).toBe(false)
    expect(editor.fontLock(buffer)).toEqual([])

    await editor.normalMode(buffer)
    expect(buffer.mode).toBe("python")
    expect(buffer.locals.get(LARGE_FILE_LITERAL_LOCAL)).toBeUndefined()
    expect(editor.fontLock(buffer).some(span => buffer.text.slice(span.start, span.end) === "def")).toBe(true)
  } finally {
    resetCustom("large-file-warning-threshold")
  }
})

test("theme support renders font-lock spans as styled TUI chunks", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()
  editor.setTheme(defaultTheme)
  const buffer = editor.scratch("theme.py", "def f():\n    return 1\n", "python")
  const rendered = visibleStyledText(buffer.text, buffer.text.length, { spans: editor.fontLock(buffer), theme: editor.theme })
  expect(rendered.chunks.length).toBeGreaterThan(1)
  expect(rendered.chunks.some(chunk => chunk.text === "def" && chunk.fg)).toBe(true)
  expect(rendered.chunks.map(chunk => chunk.text).join("")).not.toContain("\x1b[")
})

test("styled TUI chunks keep font-lock aligned when point covers highlighted text", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()
  editor.setTheme(defaultTheme)
  const buffer = editor.scratch("cursor.py", "print('hello world')\n", "python")
  buffer.point = 0

  const rendered = visibleStyledText(buffer.text, buffer.point, { spans: editor.fontLock(buffer), theme: editor.theme })
  expect(rendered.chunks.some(chunk => chunk.text === "█rint" && chunk.fg)).toBe(true)
  expect(rendered.chunks.some(chunk => chunk.text === "'hello world'" && chunk.fg)).toBe(true)
})

test("styled TUI chunks show the active region between mark and point", () => {
  const editor = new Editor()
  editor.setTheme(defaultTheme)
  const rendered = visibleStyledText("hello world", 5, { mark: 0, markActive: true, theme: editor.theme })

  expect(rendered.chunks.some(chunk => chunk.text === "hello" && chunk.bg)).toBe(true)
  expect(rendered.chunks.map(chunk => chunk.text).join("")).toBe("hello█world")
})

test("region highlight skips the line number gutter", async () => {
  const { formatWithLineNumbers, regionSpansWithLineNumbers } = await import("../src/ui/line-numbers")
  const visible = "aaa\nbbb"
  const format = formatWithLineNumbers(visible, 1)
  const spans = regionSpansWithLineNumbers(0, 5, visible, format)
  expect(spans.length).toBeGreaterThan(0)
  for (const span of spans) {
    expect(span.start).toBeGreaterThanOrEqual(format.prefixLen)
    expect(span.face).toBe("region")
  }
  const rendered = visibleStyledText(visible, 5, {
    mark: 0,
    theme: defaultTheme,
    showLineNumbers: true,
    maxLines: 10,
  })
  expect(rendered.chunks.some(chunk => chunk.text.includes("aaa") && chunk.bg)).toBe(true)
})

test("styled TUI chunks keep region highlight after movement deactivates the mark", () => {
  const editor = new Editor()
  editor.setTheme(defaultTheme)
  const rendered = visibleStyledText("hello world", 5, { mark: 0, theme: editor.theme })

  expect(rendered.chunks.some(chunk => chunk.text === "hello" && chunk.bg)).toBe(true)
})

test("C-g clears the mark and removes region highlight", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("hello world", false)
  buffer.mark = 0
  buffer.point = 5
  buffer.markActive = false

  await editor.run("keyboard-quit")
  expect(buffer.mark).toBeNull()
  expect(buffer.markActive).toBe(false)

  const rendered = visibleStyledText(buffer.text, buffer.point, { mark: buffer.mark, theme: editor.theme })
  expect(rendered.chunks.some(chunk => chunk.text === "hello" && chunk.bg)).toBe(false)
})

test("deactivate-mark deactivates without clearing the mark", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("abcdef", false)
  buffer.point = 3
  buffer.setMark()
  buffer.point = 0

  expect(editor.commands.get("clear-mark")).toBeUndefined()
  expect(editor.commands.get("deactivate-mark")).toBeDefined()
  expect(editor.commands.get("jemacs-clear-mark")).toBeDefined()
  await editor.run("deactivate-mark")
  expect(buffer.mark).toBe(3)
  expect(buffer.markActive).toBe(false)

  await editor.run("jemacs-clear-mark")
  expect(buffer.mark).toBeNull()
  expect(buffer.markActive).toBe(false)
})

test("C-x C-x exchanges point and mark like Emacs", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("abcdef", false)
  buffer.mark = 0
  buffer.point = 5
  buffer.markActive = true

  expect(editor.keymaps.feed({ name: "x", ctrl: true }).status).toBe("pending")
  expect(editor.keymaps.feed({ name: "x", ctrl: true })).toMatchObject({ status: "matched", command: "exchange-point-and-mark" })

  await editor.run("exchange-point-and-mark")
  expect(buffer.point).toBe(0)
  expect(buffer.mark).toBe(5)
  expect(buffer.markActive).toBe(true)
})

test("delete-backward-char deletes the active region like Emacs", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("hello world", false)
  buffer.mark = 0
  buffer.point = 5
  buffer.markActive = true

  await editor.run("delete-backward-char")
  expect(buffer.text).toBe(" world")
  expect(buffer.point).toBe(0)
  expect(buffer.markActive).toBe(false)
})

test("delete-backward-char ignores inactive region under transient-mark-mode", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("hello world", false)
  buffer.mark = 0
  buffer.point = 5
  buffer.markActive = false

  await editor.run("delete-backward-char")
  expect(buffer.text).toBe("hell world")
  expect(buffer.point).toBe(4)
})

test("delete-char deletes the active region like Emacs", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("hello world", false)
  buffer.mark = 6
  buffer.point = 11
  buffer.markActive = true

  await editor.run("delete-char")
  expect(buffer.text).toBe("hello ")
  expect(buffer.point).toBe(6)
  expect(buffer.markActive).toBe(false)
})

test("delete-char and delete-backward-char report Emacs boundary errors", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const messages: string[] = []
  editor.events.on("message", ({ text }) => { if (text) messages.push(text) })
  const buffer = editor.currentBuffer

  buffer.setText("abc", false)
  buffer.point = buffer.text.length
  await editor.run("delete-char")
  expect(buffer.text).toBe("abc")
  expect(messages.at(-1)).toBe("End of buffer")

  buffer.point = 0
  await editor.run("delete-backward-char")
  expect(buffer.text).toBe("abc")
  expect(messages.at(-1)).toBe("Beginning of buffer")
})

test("delete-char zero prefix is a no-op like Emacs", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("abc", false)
  buffer.point = 1

  editor.prefixArg.addDigit(0)
  await editor.run("delete-char")

  expect(buffer.text).toBe("abc")
  expect(buffer.point).toBe(1)
})

test("exchange-point-and-mark swaps point and mark; motion preserves markActive", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("abcdef", false)
  buffer.mark = 0
  buffer.point = 3
  buffer.markActive = true

  await editor.run("forward-char")
  expect(buffer.point).toBe(4)
  expect(buffer.markActive).toBe(true)

  await editor.run("exchange-point-and-mark")
  expect(buffer.point).toBe(0)
  expect(buffer.mark).toBe(4)
  expect(buffer.markActive).toBe(true)
})

test("exchange-point-and-mark requires a mark", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.currentBuffer.clearMark()
  await editor.run("exchange-point-and-mark")
  expect([...editor.buffers.values()].find(b => b.name === "*messages*")?.text).toContain("No mark set")
})

test("exchange-point-and-mark with prefix jumps without activating the region", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("abcdef", false)
  buffer.mark = 0
  buffer.point = 5
  buffer.markActive = false

  editor.prefixArg.addDigit(1)
  await editor.run("exchange-point-and-mark")
  expect(buffer.point).toBe(0)
  expect(buffer.mark).toBe(5)
  expect(buffer.markActive).toBe(false)
})

test("text-scale-adjust increases buffer scale and binds s-= in Stephen config", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  await installStephenConfig(editor)
  const buffer = editor.currentBuffer

  expect(editor.keymap.get("s-=")).toBe("text-scale-adjust")
  expect(getTextScaleAmount(buffer)).toBe(0)

  await editor.run("text-scale-adjust", [], { name: "=", sequence: "=" })
  expect(getTextScaleAmount(buffer)).toBe(1)
  expect(textScaleFactor(buffer)).toBeCloseTo(1.2)
  expect(editor.overridingMap).not.toBeNull()

  await editor.run("text-scale-adjust", [], { name: "=", sequence: "=" })
  expect(getTextScaleAmount(buffer)).toBe(2)

  await editor.run("text-scale-adjust", [], { name: "0", sequence: "0" })
  expect(getTextScaleAmount(buffer)).toBe(0)
  expect(editor.overridingMap).toBeNull()

  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 24, cols: 80 } })
  const leaf = model.windows.kind === "leaf" ? model.windows.pane : null
  expect(leaf?.textScale).toBe(1)
})

test("Stephen config binds C-x C-j and C-x C-l to buffer navigation", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  await installStephenConfig(editor)

  expect(editor.keymap.get("C-x C-j")).toBe("previous-buffer")
  expect(editor.keymap.get("C-x C-l")).toBe("next-buffer")
})

test("Stephen config installs and rust font-lock works", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  await installStephenConfig(editor)

  const spans = editor.fontLock(editor.scratch("main.rs", "fn main() { return }\n", "rust"))
  expect(spans.some(span => span.face === "keyword")).toBe(true)
})
