import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { BufferModel } from "../src/kernel/buffer"
import { isPrintable, keyToken, Keymap } from "../src/kernel/keymap"
import { Editor } from "../src/kernel/editor"
import { installDefaultCommands } from "../src/init/default-commands"
import { visibleStyledText, visibleText } from "../src/ui/opentui"

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
  expect(km.feed({ name: "x", ctrl: true }).status).toBe("pending")
  expect(km.feed({ name: "s", ctrl: true })).toEqual({ status: "matched", command: "save-buffer" })
})

test("space key is printable", () => {
  expect(isPrintable({ name: "space", sequence: " " })).toBe(true)
  expect(isPrintable({ name: "space", sequence: " ", ctrl: true })).toBe(false)
})

test("mac option key sequences map to meta bindings", () => {
  expect(keyToken({ name: "≈", sequence: "≈" })).toBe("M-x")
  expect(keyToken({ name: "ƒ", sequence: "ƒ" })).toBe("M-f")
  expect(keyToken({ name: "∫", sequence: "∫" })).toBe("M-b")
  expect(isPrintable({ name: "≈", sequence: "≈" })).toBe(false)
})

test("visible text cursor does not shift the character under point", () => {
  expect(visibleText("abc", 1)).toBe("a█c")
  expect(visibleText("abc", 3)).toBe("abc█")
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

test("default emacs keybindings are registered and runnable", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.currentBuffer.setText("abc\ndef", false)
  editor.currentBuffer.point = 0

  expect(editor.keymap.feed({ name: "f", ctrl: true })).toEqual({ status: "matched", command: "forward-char" })
  await editor.run("forward-char")
  expect(editor.currentBuffer.point).toBe(1)

  await editor.run("end-of-line")
  expect(editor.currentBuffer.point).toBe(3)
  await editor.run("kill-line")
  expect(editor.currentBuffer.text).toBe("abcdef")
  await editor.run("yank")
  expect(editor.currentBuffer.text).toBe("abc\ndef")

  expect(editor.keymap.feed({ name: "x", ctrl: true }).status).toBe("pending")
  expect(editor.keymap.feed({ name: "c", ctrl: true })).toEqual({ status: "matched", command: "quit" })
  expect(editor.keymap.feed({ name: "≈", sequence: "≈" })).toEqual({ status: "matched", command: "run-command" })
  expect(editor.keymap.feed({ name: "escape" }).status).toBe("pending")
  expect(editor.keymap.feed({ name: "x" })).toEqual({ status: "matched", command: "run-command" })
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

test("default commands support buffer listing, switching, newline, and regions", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.scratch("notes", "hello world", "text")

  await editor.run("switch-to-buffer", ["*scratch*"])
  expect(editor.currentBuffer.name).toBe("*scratch*")

  expect(editor.keymap.feed({ name: "x", ctrl: true }).status).toBe("pending")
  expect(editor.keymap.feed({ name: "b", ctrl: true })).toEqual({ status: "matched", command: "list-buffers" })
  await editor.run("list-buffers")
  expect(editor.currentBuffer.name).toBe("*Buffer List*")
  expect(editor.currentBuffer.text).toContain("notes")

  await editor.run("switch-to-buffer", ["notes"])
  editor.currentBuffer.point = 5
  await editor.run("newline")
  expect(editor.currentBuffer.text).toBe("hello\n world")

  editor.currentBuffer.mark = 0
  editor.currentBuffer.point = 5
  await editor.run("copy-region")
  editor.currentBuffer.point = editor.currentBuffer.text.length
  await editor.run("yank")
  expect(editor.currentBuffer.text.endsWith("hello")).toBe(true)

  editor.currentBuffer.mark = 0
  editor.currentBuffer.point = 5
  await editor.run("kill-region")
  expect(editor.currentBuffer.text.startsWith("\n world")).toBe(true)
})

test("help keybindings keep C-h as a prefix", () => {
  const editor = new Editor()
  installDefaultCommands(editor)

  expect(editor.keymap.feed({ name: "h", ctrl: true }).status).toBe("pending")
  expect(editor.keymap.feed({ name: "k" })).toEqual({ status: "matched", command: "describe-key" })
})

test("live reload keybinding is registered", () => {
  const editor = new Editor()
  installDefaultCommands(editor)

  expect(editor.keymap.feed({ name: "c", ctrl: true }).status).toBe("pending")
  expect(editor.keymap.feed({ name: "r", ctrl: true })).toEqual({ status: "matched", command: "reload-current-file" })
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

test("describe-key reports the winning keymap and command", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)

  expect(editor.describeKey("C-x C-f")).toContain("open-file from global-map")
  await editor.run("describe-key", ["C-x", "C-f"])
  expect(editor.currentBuffer.name).toBe("*Help*")
  expect(editor.currentBuffer.text).toContain("C-x C-f runs open-file from global-map")
})

test("keymap stack gives minibuffer bindings precedence over global bindings", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.key("tab", "quit")
  const prompt = editor.completingRead("M-x ", { collection: ["reload-current-file", "run-command"], history: "command", initialValue: "r" })

  await editor.handleKey({ name: "tab" })
  expect(editor.running).toBe(true)
  expect(editor.activeBuffer.text).toBe("r")
  expect([...editor.buffers.values()].find(b => b.name === "*Completions*")?.text).toContain("run-command")
  await editor.handleKey({ name: "g", ctrl: true })
  await prompt
})

test("prog-mode and python-mode are installed with a real python major map", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  const { getMode, modeLineage } = await import("../src/modes/mode")
  installDefaultModes()

  expect(getMode("prog-mode")?.keymap?.all()).toEqual([])
  expect(getMode("python")?.parent).toBe("prog-mode")
  expect(getMode("python")?.keymap?.get("C-M-a")).toBe("python-beginning-of-defun")
  expect(modeLineage("python").map(m => m.name)).toEqual(["python", "prog-mode", "text"])

  const editor = new Editor()
  const file = await editor.openFile("/tmp/jemacs-goal-test.py")
  expect(file.mode).toBe("python")
})

test("python mode supports indentation, defun navigation, font-lock, and TAB completion", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.scratch("example.py", "def outer():\nprint('hi')\n    return ran", "python")

  buffer.point = buffer.text.indexOf("print")
  await editor.run("indent-for-tab-command")
  expect(buffer.text).toContain("def outer():\n    print('hi')")

  buffer.point = buffer.text.length
  await editor.run("indent-for-tab-command")
  expect(buffer.text.endsWith("return range")).toBe(true)

  buffer.point = buffer.text.length
  await editor.run("python-beginning-of-defun")
  expect(buffer.point).toBe(0)
  await editor.run("python-end-of-defun")
  expect(buffer.point).toBe(buffer.text.length)

  const spans = editor.fontLock(buffer)
  expect(spans.some(span => span.face === "keyword" && buffer.text.slice(span.start, span.end) === "def")).toBe(true)
  expect(spans.some(span => span.face === "function" && buffer.text.slice(span.start, span.end) === "outer")).toBe(true)
  expect(spans.some(span => span.face === "string" && buffer.text.slice(span.start, span.end) === "'hi'")).toBe(true)
})

test("dired opens directories, follows entries, refreshes, and exposes dired keymap", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  const { getMode } = await import("../src/modes/mode")
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
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
  await editor.run("dired-revert")
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

test("theme support renders font-lock spans as styled TUI chunks", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()
  const buffer = editor.scratch("theme.py", "def f():\n    return 1\n", "python")
  const rendered = visibleStyledText(buffer.text, buffer.text.length, { spans: editor.fontLock(buffer), theme: editor.theme })
  expect(rendered.chunks.length).toBeGreaterThan(1)
  expect(rendered.chunks.some(chunk => chunk.text === "def" && chunk.attributes)).toBe(true)
  expect(rendered.chunks.map(chunk => chunk.text).join("")).not.toContain("\x1b[")
})

test("styled TUI chunks keep font-lock aligned when point covers highlighted text", async () => {
  const { installDefaultModes } = await import("../src/modes/default-modes")
  installDefaultModes()
  const editor = new Editor()
  const buffer = editor.scratch("cursor.py", "print('hello world')\n", "python")
  buffer.point = 0

  const rendered = visibleStyledText(buffer.text, buffer.point, { spans: editor.fontLock(buffer), theme: editor.theme })
  expect(rendered.chunks.some(chunk => chunk.text === "█rint" && chunk.fg)).toBe(true)
  expect(rendered.chunks.some(chunk => chunk.text === "'hello world'" && chunk.fg)).toBe(true)
})

test("styled TUI chunks show the active region between mark and point", () => {
  const editor = new Editor()
  const rendered = visibleStyledText("hello world", 5, { mark: 0, theme: editor.theme })

  expect(rendered.chunks.some(chunk => chunk.text === "hello" && chunk.bg)).toBe(true)
  expect(rendered.chunks.map(chunk => chunk.text).join("")).toBe("hello█world")
})
