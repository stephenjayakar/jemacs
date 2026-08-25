import { expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { BufferModel, FUNDAMENTAL_MODE, inferMode } from "../../src/kernel/buffer"
import { getMode, modeFeature, modeLineage } from "../../src/modes/mode"
import { installDefaultModes } from "../../src/modes/default-modes"

// Ground truth captured from GNU Emacs 30.2:
//   emacs -Q --batch --eval '(with-temp-buffer (fundamental-mode)
//     (princ (format "%S %S %S %S" major-mode (current-local-map)
//                    comment-start (get major-mode (quote derived-mode-parent)))))'
//   => fundamental-mode nil nil nil

test("fundamental-mode is installed with no parent, no keymap bindings and no comment syntax", () => {
  installDefaultModes()

  const mode = getMode(FUNDAMENTAL_MODE)
  expect(mode).toBeDefined()
  expect(mode?.parent).toBeUndefined()
  expect(mode?.keymap?.all()).toEqual([])
  expect(mode?.commentStart).toBeUndefined()
  expect(modeLineage(FUNDAMENTAL_MODE).map(m => m.name)).toEqual([FUNDAMENTAL_MODE])
})

test("fundamental-mode supplies no font-lock, indentation or completion", () => {
  installDefaultModes()

  expect(modeFeature(FUNDAMENTAL_MODE, "fontLock")).toBeUndefined()
  expect(modeFeature(FUNDAMENTAL_MODE, "indentLine")).toBeUndefined()
  expect(modeFeature(FUNDAMENTAL_MODE, "completeAtPoint")).toBeUndefined()

  const editor = new Editor()
  const buffer = editor.scratch("plain", "hello world\n", FUNDAMENTAL_MODE)
  expect(editor.fontLock(buffer)).toEqual([])
})

test("no other mode derives from fundamental-mode", () => {
  installDefaultModes()

  // In Emacs both `text-mode` and `prog-mode` have a nil derived-mode-parent,
  // so fundamental-mode must stay a leaf of the mode tree.
  expect(getMode("text")?.parent).toBeUndefined()
  expect(getMode("prog-mode")?.parent).toBe("text")
  expect(modeLineage("text").map(m => m.name)).not.toContain(FUNDAMENTAL_MODE)
})

test("a buffer with no matching rule lands in fundamental-mode", () => {
  installDefaultModes()

  expect(inferMode("LICENSE")).toBe(FUNDAMENTAL_MODE)
  expect(inferMode("README")).toBe(FUNDAMENTAL_MODE)
  expect(inferMode("data.dat")).toBe(FUNDAMENTAL_MODE)
  expect(new BufferModel({ name: "LICENSE" }).mode).toBe(FUNDAMENTAL_MODE)
  expect(new BufferModel({ name: "notes.txt" }).mode).toBe("text")
})

test("enterMode falls back to fundamental-mode for an unknown mode name", () => {
  installDefaultModes()

  const editor = new Editor()
  const buffer = editor.scratch("plain", "", FUNDAMENTAL_MODE)
  editor.enterMode(buffer, "no-such-mode")
  expect(buffer.mode).toBe(FUNDAMENTAL_MODE)
  expect(buffer.locals.get("major-mode")).toBe(FUNDAMENTAL_MODE)
})

test("fundamental-mode is reachable as a command and reported by describe-mode", async () => {
  installDefaultModes()

  const editor = new Editor()
  const { installDefaultConfig } = await import("../../src/config")
  installDefaultConfig(editor)

  const buffer = editor.scratch("script.py", "def f():\n    return 1\n", "python")
  expect(buffer.mode).toBe("python")
  await editor.run(FUNDAMENTAL_MODE)
  expect(buffer.mode).toBe(FUNDAMENTAL_MODE)
})
