/**
 * Parity tests for `customize-browse` (cus-edit.el's tree browser) and
 * `customize-create-theme` (cus-theme.el's `custom-new-theme-mode`).
 *
 * Both expected buffers were captured from GNU Emacs 30.2 `emacs -Q --batch`
 * with the same groups, options, and faces defined.
 */
import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import type { Editor } from "../../src/kernel/editor"
import { defcustom, defgroup, getCustom, resetCustom, setCustom } from "../../src/runtime/custom"
import { defface, resetFace, setFaceAttribute } from "../../src/runtime/faces"
import { getMode } from "../../src/modes/mode"

function tree(editor: Editor): string[] {
  return editor.currentBuffer.text.split("\n")
}

function browseFixture(editor: Editor): void {
  defgroup("editing", "Basic text editing facilities.")
  defgroup("bg", "BG doc.", "editing")
  defgroup("bg-sub", "BG sub doc.", "bg")
  defcustom("bg-a", "integer", 1, "A doc.", "bg")
  defcustom("bg-b", "integer", 2, "B doc.", "bg")
  defface("bg-face", { fg: "red" }, "BG face doc.", "bg")
  defcustom("bgs-x", "integer", 3, "X doc.", "bg-sub")
  void editor
}

test("customize-browse renders the cus-edit.el tree", async () => {
  const editor = makeEditor()
  browseFixture(editor)

  await editor.run("customize-browse", ["bg"])
  expect(editor.currentBuffer.name).toBe("*Customize Browser*")
  // Captured verbatim from Emacs `(customize-browse 'bg)`.
  expect(tree(editor)).toEqual([
    "Square brackets indicate buttons; type RET or click mouse-1",
    "on a button to invoke its action.",
    "Invoke [+] to expand a group, and [-] to collapse an expanded group.",
    "Invoke the [Group], [Face], and [Option] buttons below to edit that",
    "item in another window.",
    "",
    "[-]-\\ [Group] Bg",
    "   [+]-- [Group] Bg Sub",
    "    |--- [Option] Bg A",
    "    |--- [Option] Bg B",
    "    `--- [Face] Bg Face",
    "",
  ])
})

test("expanding a browser subgroup indents its children as Emacs does", async () => {
  const editor = makeEditor()
  browseFixture(editor)

  await editor.run("customize-browse", ["bg"])
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("   [+]-- [Group] Bg Sub") + 3
  await editor.run("widget-button-press")
  // Captured verbatim: the subgroup is not the last child, so its own child
  // line is prefixed with " | " and then " `--- ".
  expect(tree(editor).slice(6)).toEqual([
    "[-]-\\ [Group] Bg",
    "   [-]-\\ [Group] Bg Sub",
    "    |  `--- [Option] Bgs X",
    "    |--- [Option] Bg A",
    "    |--- [Option] Bg B",
    "    `--- [Face] Bg Face",
    "",
  ])

  // Collapsing puts it back.
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("   [-]-\\ [Group] Bg Sub") + 3
  await editor.run("widget-button-press")
  expect(tree(editor)).toContain("   [+]-- [Group] Bg Sub")
})

test("browser buttons edit the item in another window", async () => {
  const editor = makeEditor()
  browseFixture(editor)

  await editor.run("customize-browse", ["bg"])
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("[Option] Bg A")
  await editor.run("widget-button-press")
  expect(editor.currentBuffer.name).toBe("*Customize Option: Bg A*")

  await editor.run("customize-browse", ["bg"])
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("[Face] Bg Face")
  await editor.run("widget-button-press")
  expect(editor.currentBuffer.name).toBe("*Customize Face: Bg Face*")

  await editor.run("customize-browse", ["bg"])
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("[Group] Bg Sub")
  await editor.run("widget-button-press")
  expect(editor.currentBuffer.name).toBe("*Customize Group: Bg Sub*")
})

test("customize-create-theme renders custom-new-theme-mode", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("nt-a", "integer", 1, "A doc.", "editing")
  defface("nt-face", {}, "NT face doc.", "editing")
  setCustom("nt-a", 5)
  setFaceAttribute("nt-face", "fg", "#112233")

  await editor.run("customize-create-theme", ["user"])
  expect(editor.currentBuffer.name).toBe("*Custom Theme*")
  expect(editor.currentBuffer.mode).toBe("custom-new-theme-mode")
  const lines = tree(editor)
  // Layout captured from Emacs `(customize-create-theme 'user)`.
  expect(lines.slice(0, 6)).toEqual([
    "This buffer contains all the Custom settings you have made.",
    "You can convert them into a new custom theme, and optionally",
    "remove them from your saved Custom file.",
    "",
    "[ Visit Theme ]  [ Merge Theme ]  [ Revert ]",
    "",
  ])
  expect(lines[6]).toBe("Theme name : ")
  expect(lines[7]).toMatch(/^Description: Created \d{4}-\d{2}-\d{2}\.$/)
  expect(lines[8]).toBe("[ Save Theme ]  [X] Remove saved theme settings from Custom save file.")
  expect(lines).toContain("  Theme faces:")
  expect(lines).toContain("  [Insert Additional Face]")
  expect(lines).toContain("  Theme variables:")
  expect(lines).toContain("  [Insert Variable]")
  // The user's own settings are what the theme would capture.
  expect(editor.currentBuffer.text).toContain("[Nt Face]: {\"fg\":\"#112233\"}")
  expect(editor.currentBuffer.text).toContain("[Nt A]: 5")

  resetCustom("nt-a")
  resetFace("nt-face")
})

test("custom-new-theme-mode-map matches cus-theme.el", () => {
  const keymap = getMode("custom-new-theme-mode")?.keymap
  expect(keymap?.get("return")).toBe("widget-button-press")
  expect(keymap?.get("tab")).toBe("widget-forward")
  expect(keymap?.get("S-tab")).toBe("widget-backward")
  expect(keymap?.get("C-x C-s")).toBe("custom-theme-write")
  expect(keymap?.get("space")).toBe("scroll-up-command")
  expect(keymap?.get("DEL")).toBe("scroll-down-command")
  expect(keymap?.get("<")).toBe("beginning-of-buffer")
  expect(keymap?.get(">")).toBe("end-of-buffer")
  expect(keymap?.get("n")).toBe("widget-forward")
  expect(keymap?.get("p")).toBe("widget-backward")
  expect(keymap?.get("q")).toBe("Custom-buffer-done")
  expect(keymap?.get("g")).toBe("revert-buffer")
})

test("the theme editor adds faces and variables and writes them", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("nt-extra", "integer", 1, "Extra doc.", "editing")
  defface("nt-extra-face", { fg: "#445566" }, "Extra face doc.", "editing")

  await editor.run("customize-create-theme", ["user"])
  await editor.run("custom-theme-add-variable", ["nt-extra"])
  expect(editor.currentBuffer.text).toContain("[Nt Extra]: 1")
  await editor.run("custom-theme-add-face", ["nt-extra-face"])
  expect(editor.currentBuffer.text).toContain("[Nt Extra Face]: {\"fg\":\"#445566\"}")

  // The checkbox toggles.
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("[X] Remove saved")
  await editor.run("widget-button-press")
  expect(editor.currentBuffer.text).toContain("[ ] Remove saved theme settings")

  // Saving requires a name, exactly as cus-theme.el's `custom-theme-write` does.
  await editor.run("custom-theme-write")
  const messages = [...editor.buffers.values()].find(b => b.name === "*messages*")
  expect(messages?.text).toContain("Please specify a theme name")

  const buffer = editor.currentBuffer
  buffer.point = buffer.text.indexOf("Theme name : ") + "Theme name : ".length
  buffer.insert("probe-theme")
  await editor.run("custom-theme-write")
  expect(messages?.text).toContain("Wrote theme probe-theme")
  // Writing the theme saves the settings it names.
  expect(getCustom<number>("nt-extra")).toBe(1)

  resetCustom("nt-extra")
  resetFace("nt-extra-face")
})
