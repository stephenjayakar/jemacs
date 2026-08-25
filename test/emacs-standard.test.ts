import { expect, test } from "bun:test"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig as installDefaultCommands } from "../src/config"
import { keySeq } from "./harness"

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
  expect(editor.keymap.get("C-M-%")).toBe("query-replace-regexp")
  expect(editor.keymap.get("M-s o")).toBe("occur")
  expect(editor.keymap.get("M-!")).toBe("shell-command")
  expect(editor.keymap.get("M-&")).toBe("async-shell-command")
  expect(editor.keymap.get("M-|")).toBe("shell-command-on-region")
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

test("word case commands transform and move like Emacs", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("hello world foo", false)
  buffer.point = 0

  await editor.run("upcase-word")
  expect(buffer.text).toBe("HELLO world foo")
  expect(buffer.point).toBe(5)

  await editor.run("capitalize-word")
  expect(buffer.text).toBe("HELLO World foo")
  expect(buffer.point).toBe(11)

  await editor.run("downcase-word")
  expect(buffer.text).toBe("HELLO World foo")

  expect(editor.keymap.get("M-u")).toBe("upcase-word")
  expect(editor.keymap.get("M-l")).toBe("downcase-word")
  expect(editor.keymap.get("M-c")).toBe("capitalize-word")
  expect(editor.keymap.get("C-x C-u")).toBe("upcase-region")
})

test("upcase-region and capitalize-region operate on the region", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("hello world", false)
  buffer.point = 0
  buffer.setMark()
  buffer.point = 5

  await editor.run("upcase-region")
  expect(buffer.text).toBe("HELLO world")

  await editor.run("capitalize-region")
  expect(buffer.text).toBe("Hello world")
})

test("replace-regexp supports Emacs-style group references", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("foo12 bar foo34", false)
  buffer.point = 0

  await editor.run("replace-regexp", ["(foo)([0-9]+)", "\\2-\\1"])
  expect(buffer.text).toBe("12-foo bar 34-foo")
})

test("query-replace-regexp reuses query loop and supports group references", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("a1 a2 a3", false)
  buffer.point = 0

  const done = editor.run("query-replace-regexp", ["a([0-9])", "b\\1"])
  await keySeq(editor, "!")
  await done
  expect(buffer.text).toBe("b1 b2 b3")
})

test("occur lists matching lines and RET jumps to the source line", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  // scratch() registers the name with the display-name cache; renaming a
  // buffer's .name field directly would leave the cached name stale.
  const source = editor.scratch("notes.txt", "alpha\nbeta\nalphabet\ngamma\n")

  await editor.run("occur", ["alpha"])
  const occur = editor.currentBuffer
  expect(occur.name).toBe("*Occur*")
  expect(occur.mode).toBe("occur-mode")
  expect(occur.text).toBe('2 matches for "alpha" in buffer: notes.txt\n1: alpha\n3: alphabet\n')

  occur.point = occur.text.indexOf("3: alphabet")
  await editor.run("occur-mode-goto-occurrence")
  expect(editor.currentBuffer.id).toBe(source.id)
  expect(source.lineCol().line).toBe(3)
})

test("occur-edit-mode applies edited lines back to the source buffer", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const source = editor.scratch("notes.txt", "alpha\nbeta\nalphabet\ngamma\n")

  await editor.run("occur", ["alpha"])
  const occur = editor.currentBuffer
  expect(occur.readOnly).toBe(true)

  await editor.run("occur-edit-mode")
  expect(occur.mode).toBe("occur-edit-mode")
  expect(occur.readOnly).toBe(false)

  occur.setText(occur.text.replace("3: alphabet", "3: ALPHABET soup"), false)
  await editor.run("occur-cease-edit")

  expect(source.text).toBe("alpha\nbeta\nALPHABET soup\ngamma\n")
  expect(occur.mode).toBe("occur-mode")
  expect(occur.readOnly).toBe(true)
})

test("occur-cease-edit refuses to apply after line count changes", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const source = editor.scratch("notes.txt", "alpha\nbeta\nalphabet\ngamma\n")

  await editor.run("occur", ["alpha"])
  const occur = editor.currentBuffer
  await editor.run("occur-edit-mode")

  occur.setText(occur.text.replace("3: alphabet\n", ""), false)
  await editor.run("occur-cease-edit")

  expect(source.text).toBe("alpha\nbeta\nalphabet\ngamma\n")
  expect(occur.mode).toBe("occur-edit-mode")
})

test("sort-lines sorts region ascending and descending with prefix", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("c\na\nb\n", false)
  buffer.point = 0
  buffer.mark = buffer.text.length

  await editor.run("sort-lines")
  expect(buffer.text).toBe("a\nb\nc\n")

  buffer.point = 0
  buffer.mark = buffer.text.length
  editor.prefixArg.addDigit(1)
  await editor.run("sort-lines")
  expect(buffer.text).toBe("c\nb\na\n")
})

test("shell-command-on-region can replace the region with command output", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  buffer.setText("abc\nkeep", false)
  buffer.point = 0
  buffer.mark = 3
  editor.prefixArg.addDigit(1)

  await editor.run("shell-command-on-region", ["tr a-z A-Z"])
  expect(buffer.text).toBe("ABC\nkeep")
})

test("M-y outside a yank sequence browses the kill ring (Emacs 28 behavior)", async () => {
  const editor = new Editor()
  installDefaultCommands(editor)
  const buffer = editor.currentBuffer
  for (const w of ["alpha", "beta"]) {
    buffer.setText(w, false)
    buffer.point = 0
    buffer.setMark()
    buffer.point = w.length
    await editor.run("kill-region")
  }
  buffer.setText("", false)
  buffer.point = 0

  const reads: string[] = []
  editor.completingReadFunction = async (_editor, prompt, options) => {
    reads.push(prompt)
    return ((options.collection ?? []) as string[])[1] ?? null
  }

  await editor.run("yank-pop")
  expect(reads).toEqual(["Yank from kill-ring: "])
  expect(buffer.text).toBe("alpha")

  // Immediately after, M-y cycles as usual.
  await editor.run("yank-pop")
  expect(buffer.text).toBe("beta")
})
