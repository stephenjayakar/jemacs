import { expect, test } from "bun:test"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig as installDefaultCommands } from "../src/config"

test("GNU standard keys from emacs-standard are bound", () => {
  const editor = new Editor()
  installDefaultCommands(editor)

  expect(editor.keymap.get("C-/")).toBe("undo")
  expect(editor.keymap.get("M-y")).toBe("yank-pop")
  expect(editor.keymap.get("C-x 2")).toBe("split-window-below")
  expect(editor.keymap.get("C-x k")).toBe("kill-buffer")
  expect(editor.keymap.get("M-g g")).toBe("goto-line")
  expect(editor.keymap.get("C-x r SPC")).toBe("point-to-register")
  expect(editor.keymap.get("C-x left")).toBe("previous-buffer")
  expect(editor.keymap.get("C-x C-left")).toBe("previous-buffer")
  expect(editor.keymap.get("C-x right")).toBe("next-buffer")
  expect(editor.keymap.get("C-x C-right")).toBe("next-buffer")
  expect(editor.keymap.get("C-x C-j")).toBe("dired-jump")
  expect(editor.keymap.get("C-x C-l")).toBe("downcase-region")
  expect(editor.keymap.get("C-x C-r")).toBe("find-file-read-only")
  expect(editor.keymap.get("C-x C-e")).toBe("eval-last-sexp")
  expect(editor.keymap.get("M-:")).toBe("eval-expression")
  expect(editor.keymap.get("C-h f")).toBe("describe-function")
  expect(editor.keymap.get("C-h c")).toBe("describe-key-briefly")
  expect(editor.keymap.get("C-h m")).toBe("describe-mode")
})

test("beginning-of-buffer and end-of-buffer move point", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.currentBuffer.setText("one\ntwo\nthree", false)
  editor.currentBuffer.point = 5

  await editor.run("end-of-buffer")
  expect(editor.currentBuffer.point).toBe(editor.currentBuffer.text.length)

  await editor.run("beginning-of-buffer")
  expect(editor.currentBuffer.point).toBe(0)
})

test("simple.el buffer motion keys are bound", () => {
  const editor = new Editor()
  installDefaultCommands(editor)

  expect(editor.keymap.get("end")).toBe("end-of-buffer")
  expect(editor.keymap.get("C-end")).toBe("end-of-buffer")
  expect(editor.keymap.get("kp-end")).toBe("end-of-buffer")
  expect(editor.keymap.get("home")).toBe("beginning-of-buffer")
  expect(editor.keymap.get("C-home")).toBe("beginning-of-buffer")
  expect(editor.keymap.get("prior")).toBe("scroll-down-command")
  expect(editor.keymap.get("next")).toBe("scroll-up-command")
})

test("move-end-of-line with prefix moves then goes to line end", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  editor.currentBuffer.setText("aaa\nbbb\nccc", false)
  editor.currentBuffer.point = 0
  editor.prefixArg.addDigit(3)

  await editor.run("move-end-of-line")
  expect(editor.currentBuffer.point).toBe(editor.currentBuffer.text.length)
})

test("end-of-buffer with numeric prefix uses fractional position then forward-line", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const text = "0123456789\nabcdefghij"
  editor.currentBuffer.setText(text, false)
  editor.currentBuffer.point = 0
  editor.prefixArg.addDigit(5)

  await editor.run("end-of-buffer")
  expect(editor.currentBuffer.point).toBe(text.length)
})

test("beginning-of-buffer and end-of-buffer with prefix set inactive mark", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const text = "one\ntwo\nthree"
  const buffer = editor.currentBuffer
  buffer.setText(text, false)

  buffer.point = 5
  buffer.mark = null
  buffer.markActive = false
  editor.prefixArg.addDigit(5)
  await editor.run("beginning-of-buffer")
  expect(buffer.mark as number | null).toBe(5)
  expect(buffer.markActive).toBe(false)

  buffer.point = 5
  buffer.mark = null
  buffer.markActive = false
  editor.prefixArg.addDigit(5)
  await editor.run("end-of-buffer")
  expect(buffer.mark as number | null).toBe(5)
  expect(buffer.markActive).toBe(false)
})

test("beginning-of-buffer and end-of-buffer with prefix preserve active mark", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const text = "one\ntwo\nthree"
  const buffer = editor.currentBuffer
  buffer.setText(text, false)

  buffer.point = 5
  buffer.mark = 1
  buffer.markActive = true
  editor.prefixArg.addDigit(5)
  await editor.run("beginning-of-buffer")
  expect(buffer.mark).toBe(1)
  expect(buffer.markActive).toBe(true)

  buffer.point = 5
  buffer.mark = 1
  buffer.markActive = true
  editor.prefixArg.addDigit(5)
  await editor.run("end-of-buffer")
  expect(buffer.mark).toBe(1)
  expect(buffer.markActive).toBe(true)
})
