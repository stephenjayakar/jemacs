import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig, loadCustomFile, saveCustomFile } from "../src/config"
import { install as installStephenConfig } from "./fixtures/stephen-config"
import { getMode } from "../src/modes/mode"
import { defcustom, defgroup, getCustom, getCustomVariable, listCustomVariables, resetCustom, saveCustom, setCustom } from "../src/runtime/custom"
import { disableBuiltinTheme, isBuiltinThemeEnabled, listEnabledBuiltinThemes, listSavedBuiltinThemes, saveEnabledBuiltinThemes } from "../src/themes"
import { defface, getCustomFace, getCustomizedFaceOverrides, resetFace, saveFace, setFaceAttribute } from "../src/runtime/faces"
import { parseInteractiveForm } from "../src/runtime/interactive"
import { addAdvice } from "../src/runtime/advice"
import { addToLoadPath, clearLoadPath, getLoadPath } from "../src/runtime/load-path"
import { Evaluator } from "../src/runtime/evaluator"
import { isTransientMarkModeEnabled, setTransientMarkModeEnabled } from "../src/kernel/transient-mark"
/** Type TEXT into the open minibuffer and submit, then let the command run
 *  far enough to open its next prompt (or finish). */
async function answerMinibuffer(editor: Editor, text: string): Promise<void> {
  editor.activeBuffer.setText(text, true)
  editor.minibufferSubmit()
  // Two microtask turns: one for the prompt's own promise, one for the caller.
  await Promise.resolve()
  await Promise.resolve()
}

/** Last line written to *messages*, for commands whose echo is transient. */
function messagesTail(editor: Editor): string {
  const buffer = [...editor.buffers.values()].find(b => b.name === "*messages*")
  return buffer?.text.trimEnd().split("\n").at(-1) ?? ""
}

test("defcustom stores and updates values", () => {
  defcustom("jemacs-test-flag", "boolean", false, "test")
  setCustom("jemacs-test-flag", true)
  expect(getCustom<boolean>("jemacs-test-flag")).toBe(true)
})

test("parseInteractiveForm reads Emacs-style codes", () => {
  expect(parseInteractiveForm('(s)Name: ')).toEqual({ codes: ["s"], prompt: "Name: " })
  expect(parseInteractiveForm('(b)Buffer: ').codes).toEqual(["b"])
})

test("addAdvice runs before hook", async () => {
  const editor = new Editor()
  const seen: string[] = []
  editor.command("advice-target", () => {
    seen.push("run")
  })
  addAdvice("advice-target", { before: () => { seen.push("before") } })
  await editor.run("advice-target")
  expect(seen).toEqual(["before", "run"])
})

test("load-path resolves plugin modules", async () => {
  clearLoadPath()
  const dir = await mkdtemp(join(tmpdir(), "jemacs-load-"))
  const pluginPath = join(dir, "plugin.js")
  await writeFile(pluginPath, "export function install(editor) { editor.message('loaded-from-load-path') }")
  addToLoadPath(dir)
  expect(getLoadPath()).toContain(dir)

  const editor = new Editor()
  const evaluator = new Evaluator(editor)
  await evaluator.loadPlugin("plugin.js")
  expect([...editor.buffers.values()].find(b => b.name === "*messages*")?.text).toContain("loaded-from-load-path")
  clearLoadPath()
})

test("vertico-mode shows and selects minibuffer candidates", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  await installStephenConfig(editor)
  const promise = editor.prompt("Choose: ", "", undefined, { collection: ["alpha", "alphabet", "beta"] })
  editor.activeBuffer.setText("al", true)
  await editor.refreshMinibufferCompletions()
  expect(editor.minibufferCompletionDisplay?.text).toContain("alpha")
  expect(editor.minibufferCompletionDisplay?.text).toContain("alphabet")
  await editor.run("vertico-next")
  editor.minibufferSubmit()
  await expect(promise).resolves.toBe("alphabet")
  expect(editor.minibufferCompletionDisplay).toBeNull()
})

test("vertico-mode refreshes candidates while typing", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  await installStephenConfig(editor)
  const promise = editor.prompt("Choose: ", "", undefined, { collection: ["alpha", "alphabet", "beta"] })
  await editor.refreshMinibufferCompletions()
  expect(editor.minibufferCompletionDisplay?.text).toContain("alpha")
  await editor.handleKey({ name: "b", sequence: "b" })
  expect(editor.activeBuffer.text).toBe("b")
  expect(editor.minibufferCompletionDisplay?.text).toContain("beta")
  expect(editor.minibufferCompletionDisplay?.text).not.toContain("alpha")
  await editor.handleKey({ name: "backspace" })
  expect(editor.activeBuffer.text).toBe("")
  expect(editor.minibufferCompletionDisplay?.text).toContain("alpha")
  editor.minibufferCancel()
  await promise
})

test("vertico file completion displays relative names and inserts selected directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-vertico-file-"))
  await mkdir(join(dir, "src"))
  await writeFile(join(dir, "src", "main.ts"), "main")
  await writeFile(join(dir, "README.md"), "readme")
  const editor = new Editor()
  installDefaultConfig(editor)
  await installStephenConfig(editor)
  const promise = editor.completingRead("Find file: ", {
    completion: "file",
    history: "file",
    initialValue: `${dir}/`,
  })
  await editor.refreshMinibufferCompletions()

  expect(editor.minibufferCompletionDisplay?.text).toContain("src/")
  expect(editor.minibufferCompletionDisplay?.text).not.toContain(`${dir}/src/`)
  await editor.handleKey({ name: "s", sequence: "s" })
  await editor.handleKey({ name: "r", sequence: "r" })
  await editor.handleKey({ name: "c", sequence: "c" })
  expect(editor.minibufferCompletionDisplay?.text).toContain("1/1")
  expect(editor.minibufferCompletionDisplay?.text).toContain("src/")
  await editor.handleKey({ name: "tab" })
  expect(editor.activeBuffer.text).toBe(`${dir}/src/`)
  expect(editor.minibufferCompletionDisplay?.text).toContain("main.ts")
  expect(editor.minibufferCompletionDisplay?.text).not.toContain("src/")
  editor.minibufferCancel()
  await promise
})

test("vertico-mode can be disabled to use icomplete candidates", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  await installStephenConfig(editor)
  editor.disableMinorMode("vertico-mode")
  const promise = editor.prompt("Choose: ", "", undefined, { collection: ["alpha", "alphabet", "beta"] })
  editor.activeBuffer.setText("al", true)
  await editor.refreshMinibufferCompletions()
  const completions = [...editor.buffers.values()].find(b => b.name === "*Completions*")
  expect(completions?.text).toContain("alpha")
  expect(completions?.text).toContain("alphabet")
  editor.minibufferCancel()
  await promise
})

test("motion preserves markActive (transient-mark-mode semantics)", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  setTransientMarkModeEnabled(true)
  const buffer = editor.currentBuffer
  buffer.setText("abcdef", false)
  buffer.setMark()
  buffer.move(1)
  expect(buffer.markActive).toBe(true)
  buffer.insert("x")
  expect(buffer.markActive).toBe(false)
})

test("transient-mark-mode command follows GNU interactive prefix semantics", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)

  try {
    setCustom("transient-mark-mode", true)
    setTransientMarkModeEnabled(true)
    expect(editor.commands.get("toggle-transient-mark-mode")).toBeUndefined()
    expect(editor.commands.get("transient-mark-mode")).toBeDefined()
    expect(editor.commands.get("jemacs-toggle-transient-mark-mode")).toBeDefined()

    await editor.run("transient-mark-mode")
    expect(getCustom<boolean>("transient-mark-mode")).toBe(false)
    expect(isTransientMarkModeEnabled()).toBe(false)

    await editor.run("transient-mark-mode")
    expect(getCustom<boolean>("transient-mark-mode")).toBe(true)
    expect(isTransientMarkModeEnabled()).toBe(true)

    editor.prefixArg.addDigit(0)
    await editor.run("transient-mark-mode")
    expect(getCustom<boolean>("transient-mark-mode")).toBe(false)
    expect(isTransientMarkModeEnabled()).toBe(false)

    editor.prefixArg.addDigit(1)
    await editor.run("transient-mark-mode")
    expect(getCustom<boolean>("transient-mark-mode")).toBe(true)
    expect(isTransientMarkModeEnabled()).toBe(true)

    editor.prefixArg.toggleNegative()
    await editor.run("transient-mark-mode")
    expect(getCustom<boolean>("transient-mark-mode")).toBe(false)
    expect(isTransientMarkModeEnabled()).toBe(false)
  } finally {
    setCustom("transient-mark-mode", true)
    setTransientMarkModeEnabled(true)
  }
})

test("customize displays user options and updates values", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  defcustom("jemacs-customize-test-flag", "boolean", false, "test customize flag")

  await editor.run("customize-variable", ["jemacs-customize-test-flag"])
  // cus-edit.el names the buffer after the unlispified tag.
  expect(editor.currentBuffer.name).toBe("*Customize Option: Jemacs Customize Test Flag*")
  expect(editor.currentBuffer.mode).toBe("customize-mode")
  expect(getMode("customize-mode")?.keymap?.get("C-c C-c")).toBe("Custom-set")
  expect(getMode("customize-mode")?.keymap?.get("C-x C-s")).toBe("Custom-save")
  expect(editor.currentBuffer.text).toContain("Hide Jemacs Customize Test Flag: Boolean: [Toggle]  off (nil)")
  expect(editor.currentBuffer.text).toContain("[ State ]: STANDARD.")

  // `custom-prompt-variable' reads the variable, then its value.
  const setPromise = editor.run("customize-set-variable")
  expect(editor.minibuffer?.prompt).toBe("Set variable: ")
  await answerMinibuffer(editor, "jemacs-customize-test-flag")
  await answerMinibuffer(editor, "true")
  await setPromise
  expect(getCustom<boolean>("jemacs-customize-test-flag")).toBe(true)
  expect(getCustomVariable("jemacs-customize-test-flag")?.customized).toBe(true)
  expect(editor.currentBuffer.text).toContain("[ State ]: SET for current session only.")

  const savePromise = editor.run("customize-save-variable")
  expect(editor.minibuffer?.prompt).toBe("Set and save variable: ")
  await answerMinibuffer(editor, "jemacs-customize-test-flag")
  await answerMinibuffer(editor, "false")
  await savePromise
  expect(getCustom<boolean>("jemacs-customize-test-flag")).toBe(false)
  expect(getCustomVariable("jemacs-customize-test-flag")?.savedValue).toBe(false)
  expect(editor.currentBuffer.text).toContain("[ State ]: SAVED and set.")
})

test("a single-option Custom buffer matches the cus-edit.el layout", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  defgroup("jemacs-layout", "Layout probe group.")
  defcustom("jemacs-layout-count", "number", 7, "Count doc.\nSecond doc line.", "jemacs-layout")

  await editor.run("customize-variable", ["jemacs-layout-count"])
  expect(editor.currentBuffer.text.split("\n")).toEqual([
    "For help using this buffer, see [Easy Customization] in the [Emacs manual].",
    "",
    "                                         [ Search ]",
    "",
    "Operate on all settings in this buffer:",
    "[ Revert... ] [ Apply ] [ Apply and Save ]",
    "",
    "Hide Jemacs Layout Count: Number: 7",
    "   [ State ]: STANDARD.",
    "   Count doc. More",
    "Groups: [Jemacs Layout]",
    "",
  ])
  // cus-edit.el leaves point at point-min after building the buffer.
  expect(editor.currentBuffer.point).toBe(0)

  // `More' expands the rest of the doc string, `Hide' collapses it again.
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("More")
  await editor.run("Custom-newline")
  expect(editor.currentBuffer.text).toContain("   Count doc. Hide\n   Second doc line.\n")
})

test("multi-option Custom buffers collapse standard options to Show Value rows", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  defcustom("jemacs-collapse-a", "number", 1, "A doc.", "jemacs-collapse")
  defcustom("jemacs-collapse-b", "boolean", false, "B doc.", "jemacs-collapse")

  await editor.run("customize-apropos-options", ["jemacs-collapse-"])
  expect(editor.currentBuffer.name).toBe("*Customize Apropos*")
  expect(editor.currentBuffer.text).toContain("Show Value Jemacs Collapse A \n   A doc.")
  expect(editor.currentBuffer.text).toContain("Show Value Jemacs Collapse B \n   B doc.")

  // A boolean that is no longer at its standard value renders expanded, since
  // its widget's `:custom-show' is t (cus-edit.el modification of basic widgets).
  setCustom("jemacs-collapse-b", true)
  await editor.run("customize-apropos-options", ["jemacs-collapse-"])
  expect(editor.currentBuffer.text).toContain("Hide Jemacs Collapse B: Boolean: [Toggle]  on (non-nil)")
  expect(editor.currentBuffer.text).toContain("   [ State ]: SET for current session only.")
  // A non-boolean stays hidden even when set: its value widget is an editable field.
  setCustom("jemacs-collapse-a", 5)
  await editor.run("customize-apropos-options", ["jemacs-collapse-"])
  expect(editor.currentBuffer.text).toContain("Show Value Jemacs Collapse A ")

  resetCustom("jemacs-collapse-a")
  resetCustom("jemacs-collapse-b")
})

test("editing a value field and pressing Apply sets the option", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  defcustom("jemacs-field-count", "number", 1, "Field count doc.", "jemacs-field")

  await editor.run("customize-variable", ["jemacs-field-count"])
  const buffer = editor.currentBuffer
  // The value is an editable field: typing into it edits the buffer directly.
  buffer.point = buffer.text.indexOf("Number: ") + "Number: ".length + 1
  buffer.insert("2")
  expect(buffer.text).toContain("Hide Jemacs Field Count: Number: 12")

  // A one-setting buffer applies without the y-or-n confirmation.
  await editor.run("Custom-set")
  expect(getCustom<number>("jemacs-field-count")).toBe(12)
  expect(editor.currentBuffer.text).toContain("[ State ]: SET for current session only.")
})

test("Custom buffers refuse edits outside editable fields", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  defcustom("jemacs-readonly-count", "number", 1, "Read-only probe doc.", "jemacs-readonly")

  await editor.run("customize-variable", ["jemacs-readonly-count"])
  const buffer = editor.currentBuffer
  buffer.point = 0
  expect(() => buffer.insert("x")).toThrow(/outside editable field/)
  // `<remap> <self-insert-command>` -> Custom-no-edit outside a field.
  expect(editor.keymaps.lookup("a")).toMatchObject({ status: "unmatched" })
  expect(editor.keymaps.applyRemap("self-insert-command")).toBe("Custom-no-edit")
  // Inside a field ordinary keys self-insert again.
  buffer.point = buffer.text.indexOf("Number: ") + "Number: ".length
  expect(editor.keymaps.applyRemap("self-insert-command")).toBe("self-insert-command")
  buffer.insert("9")
  expect(buffer.text).toContain("Number: 91")
})

test("customize-group renders the group widget with members and subgroups", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  defgroup("jemacs-grp", "Probe group doc.")
  defgroup("jemacs-grp-sub", "Probe subgroup doc.", "jemacs-grp")
  defcustom("jemacs-grp-a", "number", 1, "A doc.", "jemacs-grp")

  await editor.run("customize-group", ["jemacs-grp"])
  expect(editor.currentBuffer.name).toBe("*Customize Group: Jemacs Grp*")
  const text = editor.currentBuffer.text
  // The root of the Custom tree is `emacs', exactly as in Emacs.
  expect(text).toContain("Parent groups: [Emacs]")
  expect(text).toContain("Jemacs Grp group: Probe group doc.")
  expect(text).toContain("      [ State ]: visible group members are all at standard values.")
  expect(text).toContain("Show Value Jemacs Grp A ")
  expect(text).toContain("Subgroups:")
  // cus-edit.el aligns subgroup docs at `custom-group-doc-align-col' (20).
  expect(text).toContain("[Jemacs Grp Sub]        Probe subgroup doc.")

  // A set member promotes the group's own state, as custom-group-state-update does.
  setCustom("jemacs-grp-a", 4)
  await editor.run("customize-group", ["jemacs-grp"])
  expect(editor.currentBuffer.text).toContain(
    "      [ State ]: something in this group has been set but not saved.",
  )
  resetCustom("jemacs-grp-a")
})

test("customize-face renders the face widget attribute checklist", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  defface("jemacs-probe-face", { fg: "#ff0000", bold: true }, "Probe face doc.", "jemacs-probe")

  await editor.run("customize-face", ["jemacs-probe-face"])
  expect(editor.currentBuffer.name).toBe("*Customize Face: Jemacs Probe Face*")
  const lines = editor.currentBuffer.text.split("\n")
  // cus-edit.el writes `[Tag]:` when the tag already ends in "face".
  expect(lines).toContain("Hide [Jemacs Probe Face]:[sample]")
  expect(lines).toContain("   [ State ]: STANDARD.")
  expect(lines).toContain("   Probe face doc.")
  expect(lines.some(line => line.startsWith("   [X] Weight: [Value Menu] bold"))).toBe(true)
  expect(lines.some(line => line.startsWith("   [X] Foreground: #ff0000"))).toBe(true)
  expect(lines).toContain("   Show All Attributes")

  // Unset attributes appear only after Show All Attributes.
  expect(editor.currentBuffer.text).not.toContain("[ ] Font Family")
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("Show All Attributes")
  await editor.run("Custom-newline")
  expect(editor.currentBuffer.text).toContain("   [ ] Font Family: ")
  expect(editor.currentBuffer.text).toContain("   Hide Unused Attributes")
})

test("setting a face attribute through the Custom buffer applies and saves it", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  defface("jemacs-apply-face", { fg: "#ff0000" }, "Apply face doc.", "jemacs-probe")

  await editor.run("customize-face", ["jemacs-apply-face"])
  const buffer = editor.currentBuffer
  const start = buffer.text.indexOf("#ff0000")
  buffer.deleteRange(start, start + "#ff0000".length)
  buffer.point = start
  buffer.insert("#00ff00")
  await editor.run("Custom-set")
  expect(getCustomFace("jemacs-apply-face")?.spec.fg).toBe("#00ff00")
  expect(editor.currentBuffer.text).toContain("[ State ]: SET for current session only.")

  await editor.run("Custom-save")
  expect(getCustomFace("jemacs-apply-face")?.savedSpec?.fg).toBe("#00ff00")
  expect(editor.currentBuffer.text).toContain("[ State ]: SAVED and set.")
  resetFace("jemacs-apply-face")
})

test("custom-file round-trips saved options and faces", async () => {
  const path = join(tmpdir(), `jemacs-custom-roundtrip-${process.pid}.ts`)
  const previous = process.env.JEMACS_CUSTOM_FILE
  process.env.JEMACS_CUSTOM_FILE = path
  try {
    const editor = new Editor()
    installDefaultConfig(editor)
    defcustom("jemacs-roundtrip-count", "number", 1, "Round-trip doc.", "jemacs-roundtrip")
    defface("jemacs-roundtrip-face", {}, "Round-trip face doc.", "jemacs-roundtrip")

    saveCustom("jemacs-roundtrip-count", 42)
    setFaceAttribute("jemacs-roundtrip-face", "fg", "#123456")
    saveFace("jemacs-roundtrip-face")
    await saveCustomFile()

    const written = await readFile(path, "utf8")
    expect(written).toContain("customSetVariables(\n")
    expect(written).toContain('  ["jemacs-roundtrip-count", 42],\n')
    expect(written).toContain('customSetFaces(\n  ["jemacs-roundtrip-face", {"fg":"#123456"}],\n)')

    // Reading it back restores both the value and the SAVED state.
    resetCustom("jemacs-roundtrip-count")
    resetFace("jemacs-roundtrip-face")
    const reader = new Editor()
    const evaluator = installDefaultConfig(reader)
    defcustom("jemacs-roundtrip-count", "number", 1, "Round-trip doc.", "jemacs-roundtrip")
    defface("jemacs-roundtrip-face", {}, "Round-trip face doc.", "jemacs-roundtrip")
    await loadCustomFile(reader, evaluator)
    expect(getCustom<number>("jemacs-roundtrip-count")).toBe(42)
    expect(getCustomVariable("jemacs-roundtrip-count")?.savedValue).toBe(42)
    expect(getCustomFace("jemacs-roundtrip-face")?.spec.fg).toBe("#123456")

    await reader.run("customize-variable", ["jemacs-roundtrip-count"])
    expect(reader.currentBuffer.text).toContain("[ State ]: SAVED and set.")
  } finally {
    if (previous == null) delete process.env.JEMACS_CUSTOM_FILE
    else process.env.JEMACS_CUSTOM_FILE = previous
    await rm(path, { force: true })
  }
})

test("customize registers Emacs customize.el command surface", () => {
  const editor = new Editor()
  installDefaultConfig(editor)

  for (const name of [
    "customize",
    "customize-group",
    "customize-group-other-window",
    "customize-variable",
    "customize-variable-other-window",
    "customize-option",
    "customize-option-other-window",
    "customize-face",
    "customize-face-other-window",
    "customize-apropos",
    "customize-apropos-options",
    "customize-apropos-faces",
    "customize-apropos-groups",
    "customize-changed",
    "customize-changed-options",
    "customize-saved",
    "customize-unsaved",
    "customize-rogue",
    "customize-mode",
    "customize-browse",
    "customize-themes",
    "customize-set-variable",
    "customize-save-variable",
    "customize-set-value",
    "customize-customized",
    "customize-save-customized",
    "customize-create-theme",
    "custom-theme-visit-theme",
    "Custom-set",
    "Custom-save",
    "Custom-buffer-done",
    "Custom-goto-parent",
    "Custom-help",
    "Custom-mode",
    "Custom-mode-menu",
    "Custom-newline",
    "Custom-no-edit",
    "Custom-reset-current",
    "Custom-reset-saved",
    "Custom-reset-standard",
    "custom-toggle-hide-all-widgets",
    "widget-browse",
    "widget-browse-at",
    "widget-browse-other-window",
    "widget-minor-mode",
    "widget-forward",
    "widget-backward",
    "widget-button-press",
    "widget-complete",
    "widget-describe",
    "custom-theme-save",
    "custom-describe-theme",
    "custom-theme-selections-toggle",
  ]) {
    expect(editor.commands.get(name), name).toBeDefined()
  }

  // cus-theme.el's theme editor, wid-edit.el's mouse entry point, and the rest
  // of cus-edit.el's interactive surface.
  for (const name of [
    "custom-new-theme-mode",
    "custom-theme-add-face",
    "custom-theme-add-variable",
    "custom-theme-write",
    "widget-button-click",
    "Custom-mode",
    "customize-toggle-option",
    "toggle-option",
    "custom-buffer-create-other-window",
    "custom-comment-show",
    "custom-variable-edit",
    "custom-variable-edit-lisp",
    "customize-icon",
    "customize-dirlocals",
    "Custom-dirlocals-save",
    "Custom-dirlocals-revert-buffer",
    "widget-field-activate",
    "widget-kill-line",
    "widget-end-of-line",
  ]) {
    expect(editor.commands.get(name), name).toBeDefined()
  }

  expect(getMode("customize-mode")?.keymap?.get("C-c C-c")).toBe("Custom-set")
  expect(getMode("customize-mode")?.keymap?.get("C-x C-s")).toBe("Custom-save")
  expect(getMode("customize-mode")?.keymap?.get("return")).toBe("Custom-newline")
  expect(getMode("customize-mode")?.keymap?.get("tab")).toBe("widget-forward")
  expect(getMode("customize-mode")?.keymap?.get("S-tab")).toBe("widget-backward")
  expect(getMode("custom-theme-choose-mode")?.keymap?.get("return")).toBe("widget-button-press")
  expect(getMode("custom-theme-choose-mode")?.keymap?.get("C-x C-s")).toBe("custom-theme-save")
  expect(getMode("custom-theme-choose-mode")?.keymap?.get("?")).toBe("custom-describe-theme")
  expect(getMode("custom-theme-choose-mode")?.keymap?.get("n")).toBe("widget-forward")
  expect(getMode("custom-theme-choose-mode")?.keymap?.get("p")).toBe("widget-backward")
})

test("customize direct setters and filtered buffers match Emacs customize flows", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  defcustom("jemacs-customize-direct-flag", "boolean", false, "direct customize flag")
  defcustom("jemacs-customize-direct-count", "number", 1, "direct customize count")

  await editor.run("customize-set-variable", ["jemacs-customize-direct-flag", "true"])
  expect(getCustom<boolean>("jemacs-customize-direct-flag")).toBe(true)

  await editor.run("customize-save-variable", ["jemacs-customize-direct-count", "7"])
  expect(getCustom<number>("jemacs-customize-direct-count")).toBe(7)
  expect(getCustomVariable("jemacs-customize-direct-count")?.savedValue).toBe(7)

  await editor.run("customize-unsaved")
  expect(editor.currentBuffer.name).toBe("*Customize Unsaved*")
  expect(editor.currentBuffer.text).toContain("Jemacs Customize Direct Flag")
  expect(editor.currentBuffer.text).not.toContain("Jemacs Customize Direct Count")

  await editor.run("customize-saved")
  expect(editor.currentBuffer.name).toBe("*Customize Saved*")
  expect(editor.currentBuffer.text).toContain("Jemacs Customize Direct Count")

  await editor.run("customize-apropos-options", ["direct-count"])
  expect(editor.currentBuffer.text).toContain("Jemacs Customize Direct Count")
  expect(editor.currentBuffer.text).not.toContain("Jemacs Customize Direct Flag")

  resetCustom("jemacs-customize-direct-flag")
  resetCustom("jemacs-customize-direct-count")
})

test("customize-unsaved and customize-saved signal when nothing matches", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  for (const variable of listCustomVariables()) if (variable.customized) resetCustom(variable.name)
  for (const { name } of getCustomizedFaceOverrides()) resetFace(name)
  await expect(editor.run("customize-unsaved")).rejects.toThrow("No user options are set but unsaved")
  await expect(editor.run("customize-saved")).rejects.toThrow("No saved user options")
  await expect(editor.run("customize-apropos-options", ["zzz-no-such-option"]))
    .rejects.toThrow(/No customizable option matching zzz-no-such-option/)
})

test("a Custom command inside a variable's block acts on that variable", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  defcustom("jemacs-backwalk-a", "boolean", false, "first backwalk option")
  defcustom("jemacs-backwalk-b", "boolean", false, "second backwalk option")

  await editor.run("customize-apropos-options", ["jemacs-backwalk"])
  const text = editor.currentBuffer.text
  expect(text).toContain("Show Value Jemacs Backwalk A ")
  expect(text).toContain("Show Value Jemacs Backwalk B ")

  // Point on B's doc line, below its heading: the [ State ] menu still acts on
  // B. (`customize-set-variable' always prompts, so point-based work goes
  // through the Custom-* buffer commands, as it does in Emacs.)
  editor.currentBuffer.point = text.indexOf("Show Value Jemacs Backwalk B")
  await editor.run("Custom-newline")            // expand B
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("[Toggle]")
  await editor.run("Custom-newline")            // toggle its value widget
  // A multi-setting buffer confirms first, as `custom-command-apply' does.
  const applied = editor.run("Custom-set")
  expect(editor.minibuffer?.prompt).toBe("Set all values according to this buffer? (y or n) ")
  await answerMinibuffer(editor, "y")
  await applied
  expect(getCustom<boolean>("jemacs-backwalk-b")).toBe(true)
  expect(getCustom<boolean>("jemacs-backwalk-a")).toBe(false)
  resetCustom("jemacs-backwalk-b")
})

test("GNU Custom commands operate on every setting in the buffer", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  defcustom("jemacs-custom-command-a", "boolean", false, "first GNU Custom command option")
  defcustom("jemacs-custom-command-b", "boolean", false, "second GNU Custom command option")

  await editor.run("customize-variable", ["jemacs-custom-command-b"])
  // [Toggle] edits the widget; Custom-set installs it (cus-edit.el two-step).
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("[Toggle]")
  await editor.run("Custom-newline")
  expect(getCustom<boolean>("jemacs-custom-command-b")).toBe(false)
  expect(editor.currentBuffer.text).toContain("[Toggle]  on (non-nil)")
  expect(editor.currentBuffer.text).toContain("[ State ]: EDITED, shown value does not take effect")

  await editor.run("Custom-set")
  expect(getCustom<boolean>("jemacs-custom-command-b")).toBe(true)
  expect(getCustom<boolean>("jemacs-custom-command-a")).toBe(false)

  await editor.run("Custom-reset-standard")
  expect(getCustom<boolean>("jemacs-custom-command-b")).toBe(false)
  expect(editor.currentBuffer.text).toContain("[ State ]: STANDARD.")
})

test("Custom-set on a multi-setting buffer confirms first", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  defcustom("jemacs-confirm-a", "boolean", false, "confirm option a")
  defcustom("jemacs-confirm-b", "boolean", false, "confirm option b")

  await editor.run("customize-apropos-options", ["jemacs-confirm-"])
  const declined = editor.run("Custom-set")
  expect(editor.minibuffer?.prompt).toBe("Set all values according to this buffer? (y or n) ")
  editor.activeBuffer.setText("n", true)
  editor.minibufferSubmit()
  await declined
  expect(messagesTail(editor)).toContain("Aborted")
})

test("widget navigation walks the buttons and fields of a Custom buffer", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  defcustom("jemacs-nav-count", "number", 3, "Nav doc.", "jemacs-nav")

  await editor.run("customize-variable", ["jemacs-nav-count"])
  const text = editor.currentBuffer.text
  // Document order, as `widget-forward' visits them in Emacs.
  const expected = [
    text.indexOf("[Easy Customization]"),
    text.indexOf("[Emacs manual]"),
    text.indexOf("\n\n") + 2, // the search field
    text.indexOf("[ Search ]"),
    text.indexOf("[ Revert... ]"),
    text.indexOf("[ Apply ]"),
    text.indexOf("[ Apply and Save ]"),
    text.indexOf("Hide Jemacs Nav Count"),
    text.indexOf("Jemacs Nav Count:"),
    text.indexOf("3\n"),
    text.indexOf("[ State ]"),
    text.indexOf("[Jemacs Nav]"),
  ]
  expect(await widgetWalk(editor, expected.length, "widget-forward")).toEqual(expected)
  // Wraps around to the first widget, as widget-move does.
  await editor.run("widget-forward")
  expect(editor.currentBuffer.point).toBe(expected[0])
  await editor.run("widget-backward")
  expect(editor.currentBuffer.point).toBe(expected[expected.length - 1])
})

test("parseCustomValue accepts boolean false aliases and rejects non-numeric numbers", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  defcustom("jemacs-parse-bool", "boolean", true, "parse boolean option")
  defcustom("jemacs-parse-number", "number", 1, "parse number option")

  for (const raw of ["nil", "off", "0"]) {
    setCustom("jemacs-parse-bool", true)
    await editor.run("customize-set-variable", ["jemacs-parse-bool", raw])
    expect(getCustom<boolean>("jemacs-parse-bool")).toBe(false)
  }

  await expect(editor.run("customize-set-variable", ["jemacs-parse-number", "abc"])).rejects.toThrow(/Invalid number/)
})

/** Fresh chooser: known theme/selection state, no leftover user customizations. */
async function themeChooserEditor(options: { customized?: boolean } = {}): Promise<Editor> {
  const editor = new Editor()
  installDefaultConfig(editor)
  await installStephenConfig(editor)
  for (const name of listEnabledBuiltinThemes()) disableBuiltinTheme(name)
  saveEnabledBuiltinThemes([])
  // installStephenConfig customizes the `default' face and several options;
  // clear them unless the test wants the "user has settings" Note branch.
  for (const { name } of getCustomizedFaceOverrides()) resetFace(name)
  for (const variable of listCustomVariables()) if (variable.customized) resetCustom(variable.name)
  setCustom("custom-theme-allow-multiple-selections", false)
  if (options.customized) setFaceAttribute("default", "family", "Fira Code, monospace")
  return editor
}

test("customize-themes renders the cus-theme.el chooser layout", async () => {
  const editor = await themeChooserEditor()

  await editor.run("customize-themes")
  expect(editor.currentBuffer.name).toBe("*Custom Themes*")
  expect(editor.currentBuffer.mode).toBe("custom-theme-choose-mode")
  // cus-theme.el ends `customize-themes' with (goto-char (point-min)).
  expect(editor.currentBuffer.point).toBe(0)
  expect(editor.currentBuffer.text.split("\n")).toEqual([
    "Type RET or click to enable/disable listed custom themes.",
    "Type ? to describe the theme at point.",
    "Themes are registered by plugins and built-ins.",
    "",
    "[ Save Theme Settings ]",
    "[ ] Select more than one theme at a time",
    "",
    "Available Custom Themes:",
    "[ ][ gruvbox-dark-hard] -- A retro-groove colour theme (dark version, hard contrast)",
    "[ ][ jemacs-dark] -- Face colors inspired by the default VS Code dark palette.",
    "[ ][ modus-vivendi] -- Elegant, highly legible theme with a black background.",
  ])
})

test("customize-themes Note block appears only when the user has customizations", async () => {
  const clean = await themeChooserEditor()
  await clean.run("customize-themes")
  expect(clean.currentBuffer.text).not.toContain("Note: Your custom settings")
  expect(clean.currentBuffer.text).not.toContain("[here]")

  const customized = await themeChooserEditor({ customized: true })
  await customized.run("customize-themes")
  expect(customized.currentBuffer.text).toContain(
    " Note: Your custom settings take precedence over theme settings.\n"
    + "       To migrate your settings into a theme, click [here].",
  )

  // RET on the migrate line runs customize-create-theme for the user settings.
  customized.currentBuffer.point = customized.currentBuffer.text.indexOf("[here]")
  await customized.run("Custom-newline")
  expect(customized.currentBuffer.name).toBe("*Custom Theme*")
  expect(customized.currentBuffer.text).toContain(
    "This buffer contains all the Custom settings you have made.",
  )
  // cus-theme.el's `custom-new-theme-mode' buffer, listing the settings that
  // would migrate into the new theme.
  expect(customized.currentBuffer.mode).toBe("custom-new-theme-mode")
  expect(customized.currentBuffer.text).toContain("[ Visit Theme ]  [ Merge Theme ]  [ Revert ]")
  expect(customized.currentBuffer.text).toContain("Theme name : ")
  expect(customized.currentBuffer.text).toContain(
    "[ Save Theme ]  [X] Remove saved theme settings from Custom save file.",
  )
  expect(customized.currentBuffer.text).toContain("  Theme faces:\n  [Default]:")
  expect(customized.currentBuffer.text).toContain("  [Insert Additional Face]")
  expect(customized.currentBuffer.text).toContain("  [Insert Variable]")
})

/** Walk `widget-forward` N times from point-min, collecting each stop. */
async function widgetWalk(editor: Editor, steps: number, command: string): Promise<number[]> {
  const stops: number[] = []
  for (let i = 0; i < steps; i++) {
    await editor.run(command)
    stops.push(editor.currentBuffer.point)
  }
  return stops
}

test("custom-theme-choose-mode widget navigation visits every widget in order", async () => {
  const editor = await themeChooserEditor()
  await editor.run("customize-themes")
  const text = editor.currentBuffer.text
  expect(text).not.toContain("[here]")
  const expected = [
    text.indexOf("[ Save Theme Settings ]"),
    text.indexOf("[ ] Select more than one"),
    text.indexOf("[ ][ gruvbox-dark-hard]"),
    text.indexOf("[ ][ jemacs-dark]"),
    text.indexOf("[ ][ modus-vivendi]"),
  ]

  expect(await widgetWalk(editor, expected.length, "widget-forward")).toEqual(expected)
  expect(await widgetWalk(editor, expected.length - 1, "widget-backward"))
    .toEqual([...expected].reverse().slice(1))
  // widget-move wraps: backward from the first widget lands on the last.
  await editor.run("widget-backward")
  expect(editor.currentBuffer.point).toBe(expected[expected.length - 1])
})

test("custom-theme-choose-mode widget navigation includes the [here] migrate link", async () => {
  const editor = await themeChooserEditor({ customized: true })
  await editor.run("customize-themes")
  const text = editor.currentBuffer.text
  // Document order: the Note's `here' link, save button, multi-select checkbox,
  // then one checkbox per theme — the same stops `widget-forward' makes in Emacs.
  const expected = [
    text.indexOf("[here]"),
    text.indexOf("[ Save Theme Settings ]"),
    text.indexOf("[ ] Select more than one"),
    text.indexOf("[ ][ gruvbox-dark-hard]"),
    text.indexOf("[ ][ jemacs-dark]"),
    text.indexOf("[ ][ modus-vivendi]"),
  ]
  expect(expected[0]).toBeGreaterThan(0)
  expect(expected).toEqual([...expected].sort((a, b) => a - b))

  expect(await widgetWalk(editor, expected.length, "widget-forward")).toEqual(expected)
  expect(await widgetWalk(editor, expected.length - 1, "widget-backward"))
    .toEqual([...expected].reverse().slice(1))

  // The backward walk ended on `here'; landing there is enough to activate it.
  expect(editor.currentBuffer.point).toBe(expected[0])
  await editor.run("Custom-newline")
  expect(editor.currentBuffer.name).toBe("*Custom Theme*")
})

test("custom-theme-choose-mode-map matches cus-theme.el (SPC scrolls, no s binding)", () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  const keymap = getMode("custom-theme-choose-mode")?.keymap
  // widget-keymap plus C-x C-s / n / p / ?.
  expect(keymap?.get("return")).toBe("widget-button-press")
  expect(keymap?.get("tab")).toBe("widget-forward")
  expect(keymap?.get("S-tab")).toBe("widget-backward")
  expect(keymap?.get("C-x C-s")).toBe("custom-theme-save")
  expect(keymap?.get("n")).toBe("widget-forward")
  expect(keymap?.get("p")).toBe("widget-backward")
  expect(keymap?.get("?")).toBe("custom-describe-theme")
  // special-mode-map inheritance: SPC scrolls, it does not toggle a widget.
  expect(keymap?.get("space")).toBe("scroll-up-command")
  expect(keymap?.get("S-space")).toBe("scroll-down-command")
  expect(keymap?.get("DEL")).toBe("scroll-down-command")
  expect(keymap?.get("<")).toBe("beginning-of-buffer")
  expect(keymap?.get(">")).toBe("end-of-buffer")
  expect(keymap?.get("g")).toBe("revert-buffer")
  expect(keymap?.get("q")).toBe("Custom-buffer-done")
  // Print the resolved map so the binding table is visible, not inferred.
  const resolved = Object.fromEntries(
    ["return", "tab", "S-tab", "C-x C-s", "n", "p", "?", "space", "S-space", "DEL",
      "<", ">", "h", "g", "q", "s", "S-s"].map(key => [key, keymap?.get(key)]),
  )
  expect(resolved).toEqual({
    "return": "widget-button-press",
    "tab": "widget-forward",
    "S-tab": "widget-backward",
    "C-x C-s": "custom-theme-save",
    "n": "widget-forward",
    "p": "widget-backward",
    "?": "custom-describe-theme",
    "space": "scroll-up-command",
    "S-space": "scroll-down-command",
    "DEL": "scroll-down-command",
    "<": "beginning-of-buffer",
    ">": "end-of-buffer",
    "h": "describe-mode",
    "g": "revert-buffer",
    "q": "Custom-buffer-done",
    "s": undefined,
    "S-s": undefined,
  })
  // cus-theme.el binds no plain `s'; only C-x C-s and the save widget save.
  expect(keymap?.get("s")).toBeUndefined()
  expect(keymap?.get("S-s")).toBeUndefined()
})

test("g in the themes buffer confirms before discarding choices", async () => {
  const editor = await themeChooserEditor()
  await editor.run("customize-themes")
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("][ gruvbox-dark-hard]")
  await editor.run("Custom-newline")
  expect(isBuiltinThemeEnabled("gruvbox-dark-hard")).toBe(true)

  // Press `g' through the keymap, not editor.run, so the binding itself is tested.
  const declined = editor.handleKey({ name: "g", sequence: "g" })
  expect(editor.minibuffer?.prompt).toBe("Discard current choices? (y or n) ")
  editor.activeBuffer.setText("n", true)
  editor.minibufferSubmit()
  await declined
  expect(editor.currentBuffer.name).toBe("*Custom Themes*")

  const accepted = editor.handleKey({ name: "g", sequence: "g" })
  expect(editor.minibuffer?.prompt).toBe("Discard current choices? (y or n) ")
  editor.activeBuffer.setText("y", true)
  editor.minibufferSubmit()
  await accepted
  expect(editor.currentBuffer.name).toBe("*Custom Themes*")
  expect(editor.currentBuffer.text).toContain("[X][ gruvbox-dark-hard] --")
})

test("customize-themes toggles, single-selects, and saves plugin themes", async () => {
  const editor = await themeChooserEditor()
  await editor.run("customize-themes")
  const gotoTheme = (name: string) => {
    editor.currentBuffer.point = editor.currentBuffer.text.indexOf(`][ ${name}]`)
  }

  gotoTheme("gruvbox-dark-hard")
  await editor.run("Custom-newline")
  expect(isBuiltinThemeEnabled("gruvbox-dark-hard")).toBe(true)
  expect(editor.theme.name).toBe("gruvbox-dark-hard")
  expect(editor.currentBuffer.text).toContain("[X][ gruvbox-dark-hard] --")

  // Single-selection: checking another box unchecks the first.
  gotoTheme("modus-vivendi")
  await editor.run("Custom-newline")
  expect(isBuiltinThemeEnabled("gruvbox-dark-hard")).toBe(false)
  expect(editor.currentBuffer.text).toContain("[ ][ gruvbox-dark-hard] --")
  expect(editor.currentBuffer.text).toContain("[X][ modus-vivendi] --")

  await editor.run("custom-theme-save")
  expect(listSavedBuiltinThemes()).toEqual(["modus-vivendi"])

  gotoTheme("modus-vivendi")
  await editor.run("Custom-newline")
  expect(isBuiltinThemeEnabled("modus-vivendi")).toBe(false)
})

test("enable-theme with an explicit argument does not disable other themes", async () => {
  const editor = await themeChooserEditor()
  // `enable-theme' is not the chooser checkbox: de-selection lives in
  // `custom-theme-checkbox-toggle', so an explicit M-x enable-theme is additive.
  await editor.run("enable-theme", ["gruvbox-dark-hard"])
  await editor.run("enable-theme", ["modus-vivendi"])
  expect(listEnabledBuiltinThemes().sort()).toEqual(["gruvbox-dark-hard", "modus-vivendi"])
  expect(editor.theme.name).toBe("modus-vivendi")
})

test("customize-themes multi-selection checkbox and ? describe theme", async () => {
  const editor = await themeChooserEditor()
  await editor.run("customize-themes")
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("[ ] Select more than one")
  await editor.run("Custom-newline")
  expect(getCustom<boolean>("custom-theme-allow-multiple-selections")).toBe(true)
  expect(editor.currentBuffer.text).toContain("[X] Select more than one theme at a time")

  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("][ gruvbox-dark-hard]")
  await editor.run("Custom-newline")
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("][ modus-vivendi]")
  await editor.run("Custom-newline")
  expect(isBuiltinThemeEnabled("gruvbox-dark-hard")).toBe(true)
  expect(isBuiltinThemeEnabled("modus-vivendi")).toBe(true)

  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("][ modus-vivendi]")
  await editor.run("custom-describe-theme")
  expect(editor.currentBuffer.name).toBe("*Help*")
  // `describe-theme-1' layout from cus-theme.el.
  expect(editor.currentBuffer.text.split("\n")).toEqual([
    "modus-vivendi is a custom theme in \u2018modus-vivendi.ts\u2019.",
    "It is loaded and enabled.",
    "",
    "Documentation:",
    "Elegant, highly legible theme with a black background.",
    "Conforms with the highest legibility standard for color contrast",
    "between background and foreground in any given piece of text,",
    "which corresponds to a minimum contrast in relative luminance of",
    "7:1 (WCAG AAA standard).",
    "",
    "You can customize this theme.",
  ])
})
