/**
 * The three cus-edit.el setters, `customize-icon`, and `customize-dirlocals`.
 *
 * The distinction between `customize-set-value` and `customize-set-variable`
 * was probed against GNU Emacs 30.2:
 *
 *   (customize-set-value 'sv-a 5)    => state=changed  customized-value=nil
 *   (customize-set-variable 'sv-b 5) => state=set      customized-value=(5)
 */
import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "../plugins/helper"
import {
  defcustom,
  defgroup,
  defineIcon,
  getCustom,
  getCustomIcon,
  getCustomVariable,
  resetCustom,
  resetCustomIcon,
} from "../../src/runtime/custom"

test("customize-set-value sets the value without recording a customization", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("sv-plain", "integer", 1, "Plain doc.", "editing")

  await editor.run("customize-set-value", ["sv-plain", "5"])
  expect(getCustom<number>("sv-plain")).toBe(5)
  // Emacs: no `customized-value`, so the state is CHANGED outside Customize.
  expect(getCustomVariable("sv-plain")?.customized).toBeFalsy()
  await editor.run("customize-variable", ["sv-plain"])
  expect(editor.currentBuffer.text).toContain("[ State ]: CHANGED outside Customize.")
  expect(editor.currentBuffer.text).toContain("Hide Sv Plain: Integer: 5")
  resetCustom("sv-plain")
})

test("customize-set-variable records the customization, so the state is SET", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("sv-custom", "integer", 1, "Custom doc.", "editing")

  await editor.run("customize-set-variable", ["sv-custom", "5"])
  expect(getCustom<number>("sv-custom")).toBe(5)
  expect(getCustomVariable("sv-custom")?.customized).toBe(true)
  await editor.run("customize-variable", ["sv-custom"])
  expect(editor.currentBuffer.text).toContain("[ State ]: SET for current session only.")
  resetCustom("sv-custom")
})

test("the three setters use Emacs's three prompts", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("sv-prompt", "integer", 1, "Prompt doc.", "editing")

  const cases: Array<[string, string]> = [
    ["customize-set-value", "Set sv-prompt to value: "],
    ["customize-set-variable", "Set customized value for sv-prompt to: "],
    ["customize-save-variable", "Set and save value for sv-prompt as: "],
  ]
  for (const [command, prompt] of cases) {
    const pending = editor.run(command, ["sv-prompt"])
    expect(editor.minibuffer?.prompt, command).toBe(prompt)
    editor.minibufferCancel()
    try { await pending } catch { /* cancelled */ }
  }
  resetCustom("sv-prompt")
})

test("a prefix argument makes the setters prompt for a comment", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("sv-comment", "integer", 1, "Comment doc.", "editing")

  // customize-set-value with a comment attaches it without customizing.
  await editor.run("customize-set-value", ["sv-comment", "7", "a note"])
  expect(getCustomVariable("sv-comment")?.comment).toBe("a note")
  expect(getCustomVariable("sv-comment")?.customized).toBeFalsy()
  await editor.run("customize-variable", ["sv-comment"])
  expect(editor.currentBuffer.text).toContain("Comment: a note")
  expect(editor.currentBuffer.text).toContain("[ State ]: CHANGED outside Customize.")
  resetCustom("sv-comment")
})

test("customize-icon renders the Emacs custom-icon widget verbatim", async () => {
  const editor = makeEditor()
  // Emacs's own `button' icon. `(icon-complete-spec 'button nil t)` gives
  //   ((image :face icon-button) (emoji "\u{1F535}" :face icon)
  //    (symbol "\u25CF" :face icon-button) (text "button" :face icon-button))
  defineIcon("button", [
    { kind: "image", values: [], keywords: [[":face", "icon-button"]] },
    { kind: "emoji", values: ["\u{1F535}"], keywords: [[":face", "icon"]] },
    { kind: "symbol", values: ["\u25CF"], keywords: [[":face", "icon-button"]] },
    { kind: "text", values: ["button"], keywords: [[":face", "icon-button"]] },
  ], "Base icon for buttons.")

  await editor.run("customize-icon", ["button"])
  expect(editor.currentBuffer.name).toBe("*Customize Icon: Button*")
  // Captured from `emacs -Q --batch` running `(customize-icon 'button)`, with
  // tabs resolved by Emacs itself. Only the button row differs: `emacs -Q` has
  // no custom-file, so it cannot offer `[ Apply and Save ]`.
  expect(editor.currentBuffer.text.split("\n")).toEqual([
    "For help using this buffer, see [Easy Customization] in the [Emacs manual].",
    "",
    "                                         [ Search ]",
    "",
    "Operate on all settings in this buffer:",
    "[ Revert... ] [ Apply ] [ Apply and Save ]",
    "",
    "Hide Button:",
    "Repeat:",
    "[INS] [DEL] List:",
    "            Choice: [Value Menu] Images",
    "            Repeat:",
    "            [INS]",
    "            Plist:",
    "            [INS] [DEL] :",
    "                        Key: :face",
    "                        Value: icon-button",
    "            [INS]",
    "[INS] [DEL] List:",
    "            Choice: [Value Menu] Colorful Emojis",
    "            Repeat:",
    "            [INS] [DEL] String: \ud83d\udd35",
    "            [INS]",
    "            Plist:",
    "            [INS] [DEL] :",
    "                        Key: :face",
    "                        Value: icon",
    "            [INS]",
    "[INS] [DEL] List:",
    "            Choice: [Value Menu] Monochrome Symbols",
    "            Repeat:",
    "            [INS] [DEL] String: \u25cf",
    "            [INS]",
    "            Plist:",
    "            [INS] [DEL] :",
    "                        Key: :face",
    "                        Value: icon-button",
    "            [INS]",
    "[INS] [DEL] List:",
    "            Choice: [Value Menu] Text Only",
    "            Repeat:",
    "            [INS] [DEL] String: button",
    "            [INS]",
    "            Plist:",
    "            [INS] [DEL] :",
    "                        Key: :face",
    "                        Value: icon-button",
    "            [INS]",
    "[INS]",
    "   [ State ]: STANDARD.",
    "   Base icon for buttons.",
    "Groups: [Nil]",
    "",
  ])
  resetCustomIcon("button")
})

test("editing an icon's text spec and applying installs it", async () => {
  const editor = makeEditor()
  defineIcon("probe-icon", [{ kind: "text", values: ["undo"] }], "Probe icon doc.", "editing")
  await editor.run("customize-icon", ["probe-icon"])
  const buffer = editor.currentBuffer
  const at = buffer.text.indexOf("String: undo") + "String: ".length
  buffer.deleteRange(at, at + "undo".length)
  buffer.point = at
  buffer.insert("redo")
  await editor.run("Custom-set")
  expect(getCustomIcon("probe-icon")?.spec[0]?.values).toEqual(["redo"])
  expect(editor.currentBuffer.text).toContain("[ State ]: SET for current session only.")
  resetCustomIcon("probe-icon")
})

test("customize-icon signals for an unknown icon, as Emacs does", async () => {
  const editor = makeEditor()
  await expect(editor.run("customize-icon", ["no-such-icon"]))
    .rejects.toThrow("no-such-icon is not a valid icon")
})

test("customize-dirlocals renders the Emacs buffer verbatim", async () => {
  const editor = makeEditor()
  defcustom("fill-column", "integer", 70, "Column doc.", "fill")
  const dir = await mkdtemp(join(tmpdir(), "jemacs-dirlocals-"))
  const file = join(dir, ".dir-locals.el")
  try {
    await writeFile(file, "((nil . ((fill-column . 88))))\n")
    await editor.run("customize-dirlocals", [file])
    expect(editor.currentBuffer.name).toBe("*Customize Dirlocals*")
    // Captured from `emacs -Q --batch` running `(customize-dirlocals FILE)`
    // over the same `.dir-locals.el`.
    expect(editor.currentBuffer.text.split("\n")).toEqual([
      "This buffer is for customizing the Directory Local Variables in:",
      `File: ${dir}/.dir-locals.el`,
      "",
      "To select another file, edit the above field and hit RET.",
      "",
      "After you enter a user option name under the symbol field,",
      "be sure to press RET or TAB, so that the field that holds the",
      "value changes to an appropriate field for the option.",
      "",
      "Type C-x C-s when you\u2019ve finished editing it, to save the",
      "settings to the file.",
      "",
      "",
      "[ Revert ] [ Save Settings ]",
      "",
      "[INS] [DEL] Specification: All modes",
      "            Settings:",
      "            [INS] [DEL] Setting:",
      "                        Symbol: fill-column",
      "                        Integer: 88",
      "            [INS]",
      "[INS]",
      "",
    ])

    // Edit the value and save it back as real elisp.
    const buffer = editor.currentBuffer
    const at = buffer.text.indexOf("Integer: 88") + "Integer: ".length
    buffer.deleteRange(at, at + 2)
    buffer.point = at
    buffer.insert("99")
    await editor.run("Custom-dirlocals-save")
    const written = await readFile(file, "utf8")
    expect(written).toContain("(fill-column . 99)")
    // ...and it round-trips through the reader.
    await editor.run("customize-dirlocals", [file])
    expect(editor.currentBuffer.text).toContain("Integer: 99")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("customize-dirlocals starts empty when there is no dir-locals file", async () => {
  const editor = makeEditor()
  const dir = await mkdtemp(join(tmpdir(), "jemacs-dirlocals-empty-"))
  try {
    await editor.run("customize-dirlocals", [join(dir, ".dir-locals.el")])
    expect(editor.currentBuffer.name).toBe("*Customize Dirlocals*")
    // Only the trailing [INS] that adds the first specification.
    expect(editor.currentBuffer.text).toContain("[ Revert ] [ Save Settings ]")
    expect(editor.currentBuffer.text.trimEnd().endsWith("[INS]")).toBe(true)

    // That [INS] adds a specification row.
    const buffer = editor.currentBuffer
    buffer.point = buffer.text.trimEnd().lastIndexOf("[INS]")
    await editor.run("widget-button-press")
    expect(editor.currentBuffer.text).toContain("[INS] [DEL] Specification: All modes")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
