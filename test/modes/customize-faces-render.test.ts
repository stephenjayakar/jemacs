/**
 * Parity tests for how a Custom buffer is *coloured*.
 *
 * cus-edit.el propertizes each widget as it inserts it, so a Custom buffer in
 * Emacs is never one flat colour. These tests compare against fixtures
 * captured from GNU Emacs 30.2, not against jemacs' own output: each line of
 * `test/fixtures/emacs/*.txt` is `START<TAB>END<TAB>FACE<TAB>TEXT` produced by
 * walking `next-single-char-property-change` over the `face` property.
 *
 * The capture ran with `custom-file` set, because `emacs -Q` cannot save and
 * therefore omits the `[ Apply and Save ]` button and shifts every offset.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { makeEditor } from "../plugins/helper"
import type { Editor } from "../../src/kernel/editor"
import {
  customGroupChildren,
  defcustom,
  defgroup,
  getCustomGroup,
  resetCustom,
  setCustom,
  TOP_CUSTOM_GROUP,
} from "../../src/runtime/custom"
import { defface, getCustomFace, resetFace } from "../../src/runtime/faces"
import { modeFeature } from "../../src/modes/mode"

type Run = { start: number; end: number; face: string; text: string }

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "emacs")

/** Emacs draws the group rule with an anonymous `(:underline t)` spec; jemacs
 *  names that face `custom-group-rule`. Same rendering, different spelling. */
function normaliseFace(face: string): string {
  return face === "(:underline t)" || face === "custom-group-rule" ? "<group-rule>" : face
}

/** Parse a captured fixture. Emacs's `%S` prints a real newline inside a
 *  string, so a run's text can span input lines. */
function readFixture(name: string): Run[] {
  const runs: Run[] = []
  let current: Run | null = null
  // Drop the file's own trailing newline before splitting, so it is not read
  // as a continuation of the last run's text.
  const body = readFileSync(join(FIXTURES, name), "utf8").replace(/\n$/, "")
  for (const line of body.split("\n")) {
    const match = /^(\d+)\t(\d+)\t(.+?)\t(.*)$/.exec(line)
    if (match) {
      if (current) runs.push(current)
      current = {
        start: Number(match[1]),
        end: Number(match[2]),
        face: normaliseFace(match[3]!),
        text: match[4]!,
      }
    } else if (current) {
      current.text += `\n${line}`
    }
  }
  if (current) runs.push(current)
  // Unwrap the `"…"` quoting `%S` applied, and collapse the embedded newline
  // so a run reads the same either side.
  return runs.map(run => ({ ...run, text: run.text.replace(/^"|"$/g, "").replace(/\n/g, "\\n") }))
}

/** The current buffer's faced runs, in the fixtures' shape. */
function facedRuns(editor: Editor): Run[] {
  const buffer = editor.currentBuffer
  const fontLock = modeFeature(buffer.mode, "fontLock")
  expect(fontLock, `${buffer.mode} has no font-lock`).toBeDefined()
  return (fontLock!(buffer) as Array<{ start: number; end: number; face: string }>)
    .map(span => ({
      start: span.start,
      end: span.end,
      face: normaliseFace(span.face),
      text: buffer.text.slice(span.start, span.end).replace(/\n/g, "\\n"),
    }))
}

test("a Custom option buffer matches Emacs's face runs, offset for offset", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("cc-a", "integer", 1, "A doc.", "editing")
  await editor.run("customize-variable", ["cc-a"])

  expect(facedRuns(editor)).toEqual(readFixture("customize-option-face-runs.txt"))
  resetCustom("cc-a")
})

/** `(get 'emacs 'custom-group)` in GNU Emacs 30.2. */
const EMACS_ROOT_CHILDREN = [
  "editing", "convenience", "files", "wp", "text", "data", "external", "comm",
  "programming", "applications", "development", "environment", "faces",
  "help", "multimedia", "local",
]

test("the root group buffer matches Emacs's face runs, offset for offset", async () => {
  const editor = makeEditor()
  // The registry is process-global, so other test files leave probe groups
  // hanging off the root. Reparent them, as a real `defgroup` would.
  for (const name of customGroupChildren(TOP_CUSTOM_GROUP)) {
    if (EMACS_ROOT_CHILDREN.includes(name)) continue
    defgroup(name, getCustomGroup(name)?.doc ?? `${name} probe group.`, { parent: "local" })
  }
  await editor.run("customize")
  expect(facedRuns(editor)).toEqual(readFixture("customize-group-face-runs.txt"))
})

test("a set option matches Emacs's runs, including the Apply buttons", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("cc-a", "integer", 1, "A doc.", "editing")
  // The fixture was captured after `(customize-set-variable 'cc-a 5)`.
  setCustom("cc-a", 5)
  await editor.run("customize-variable", ["cc-a"])

  expect(facedRuns(editor)).toEqual(readFixture("customize-option-set-face-runs.txt"))
  resetCustom("cc-a")
})

test("the Apply buttons activate exactly as custom-commands says", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("cc-b", "integer", 1, "B doc.", "editing")

  const applyFaces = () => facedRuns(editor)
    .filter(run => run.text.includes("Apply"))
    .map(run => run.face)

  // `custom-commands`: Apply is `(modified)`; Apply and Save is
  // `(modified set changed rogue)`. Both fixtures above pin the standard and
  // set cases; this walks the modified case in between.
  await editor.run("customize-variable", ["cc-b"])
  expect(applyFaces()).toEqual(["widget-inactive", "widget-inactive"])

  const buffer = editor.currentBuffer
  buffer.point = buffer.text.indexOf("Integer: ") + "Integer: ".length
  buffer.insert("9")
  await editor.run("customize-refresh")
  expect(applyFaces()).toEqual(["custom-button-unraised", "custom-button-unraised"])

  setCustom("cc-b", 5)
  await editor.run("customize-variable", ["cc-b"])
  expect(applyFaces()).toEqual(["widget-inactive", "custom-button-unraised"])
  resetCustom("cc-b")
})

test("widget-field extends through the newline, as :extend t does", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("cc-ext", "integer", 1, "Ext doc.", "editing")
  await editor.run("customize-variable", ["cc-ext"])

  // Emacs's run for the value field is `"1\n"`: `widget-field` is `:extend t`,
  // so the highlight reaches the end of the line.
  const valueRun = facedRuns(editor).find(run => run.face === "widget-field" && run.text.startsWith("1"))
  expect(valueRun?.text).toBe("1\\n")
  resetCustom("cc-ext")
})

test("the State description is always custom-state, whatever the state", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  // Named `cc-a` like the fixture, so the offsets are directly comparable.
  defcustom("cc-a", "integer", 1, "A doc.", "editing")

  const stateRun = () => facedRuns(editor).find(run => run.text.endsWith("."))

  // cus-edit.el's `custom-magic-value-create` propertizes the description with
  // `custom-state` unconditionally; `custom-magic-alist`'s per-state faces are
  // the hidden magic glyph's `:button-face`, not this text. Both fixtures above
  // confirm it: STANDARD. and "SET for current session only." share the face.
  await editor.run("customize-variable", ["cc-a"])
  expect(stateRun()).toEqual({ start: 250, end: 259, face: "custom-state", text: "STANDARD." })

  setCustom("cc-a", 7)
  await editor.run("customize-variable", ["cc-a"])
  expect(stateRun()?.face).toBe("custom-state")
  expect(stateRun()?.text).toBe("SET for current session only.")
  resetCustom("cc-a")
})

test("a face buffer colours its tag with custom-face-tag", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defface("cc-face", { bold: true }, "Face doc.", "editing")

  await editor.run("customize-face", ["cc-face"])
  const runs = facedRuns(editor)
  expect(runs.some(run => run.face === "custom-face-tag" && run.text === "[Cc Face]")).toBe(true)
  expect(getCustomFace("cc-face")).toBeDefined()
  resetFace("cc-face")
})

test("the theme chooser colours its checkboxes and summaries", async () => {
  const editor = makeEditor()
  await editor.run("customize-themes")
  const runs = facedRuns(editor)
  expect(runs.some(run => run.face === "custom-button-unraised" && run.text === "[ ]")).toBe(true)
  expect(runs.some(run => run.face === "custom-variable-tag")).toBe(true)
  expect(runs.some(run => run.face === "custom-documentation")).toBe(true)
})
