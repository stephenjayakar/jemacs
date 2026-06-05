import { expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig } from "../src/config"
import { install as installStephenConfig } from "./fixtures/stephen-config"
import { getMode } from "../src/modes/mode"
import { defcustom, getCustom, getCustomVariable, setCustom } from "../src/runtime/custom"
import { disableBuiltinTheme, isBuiltinThemeEnabled, listSavedBuiltinThemes, saveEnabledBuiltinThemes } from "../src/themes"
import { parseInteractiveForm } from "../src/runtime/interactive"
import { addAdvice } from "../src/runtime/advice"
import { addToLoadPath, clearLoadPath, getLoadPath } from "../src/runtime/load-path"
import { Evaluator } from "../src/runtime/evaluator"
import { setTransientMarkModeEnabled } from "../src/kernel/transient-mark"

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
  installStephenConfig(editor)
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
  installStephenConfig(editor)
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
  installStephenConfig(editor)
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
  installStephenConfig(editor)
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

test("customize displays user options and updates values", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  defcustom("jemacs-customize-test-flag", "boolean", false, "test customize flag")

  await editor.run("customize-variable", ["jemacs-customize-test-flag"])
  expect(editor.currentBuffer.name).toBe("*Customize*")
  expect(editor.currentBuffer.mode).toBe("customize-mode")
  expect(getMode("customize-mode")?.keymap?.get("s")).toBe("customize-set-variable")
  expect(getMode("customize-mode")?.keymap?.get("S-s")).toBe("customize-save-variable")
  expect(editor.currentBuffer.text).toContain("Variable: jemacs-customize-test-flag")
  expect(editor.currentBuffer.text).toContain("State: STANDARD")

  const setPromise = editor.run("customize-set-variable")
  editor.activeBuffer.setText("true", true)
  editor.minibufferSubmit()
  await setPromise
  expect(getCustom<boolean>("jemacs-customize-test-flag")).toBe(true)
  expect(getCustomVariable("jemacs-customize-test-flag")?.customized).toBe(true)
  expect(editor.currentBuffer.text).toContain("State: SET for current session")

  const savePromise = editor.run("customize-save-variable")
  editor.activeBuffer.setText("false", true)
  editor.minibufferSubmit()
  await savePromise
  expect(getCustom<boolean>("jemacs-customize-test-flag")).toBe(false)
  expect(getCustomVariable("jemacs-customize-test-flag")?.savedValue).toBe(false)
  expect(editor.currentBuffer.text).toContain("State: SAVED and set")
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
    "customize-save-customized",
    "customize-create-theme",
    "custom-theme-visit-theme",
    "widget-browse",
    "widget-browse-at",
    "widget-browse-other-window",
    "widget-minor-mode",
  ]) {
    expect(editor.commands.get(name), name).toBeDefined()
  }

  for (const name of [
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
    "customize-customized",
    "custom-toggle-hide-all-widgets",
    "widget-forward",
    "widget-backward",
    "widget-button-press",
    "widget-complete",
    "widget-describe",
  ]) {
    expect(editor.commands.get(name), name).toBeUndefined()
  }

  expect(getMode("customize-mode")?.keymap?.get("C-c C-c")).toBe("customize-set-variable")
  expect(getMode("customize-mode")?.keymap?.get("C-x C-s")).toBe("customize-save-variable")
  expect(getMode("customize-mode")?.keymap?.get("return")).toBe("customize-set-variable")
  expect(getMode("customize-mode")?.keymap?.get("tab")).toBe("next-line")
  expect(getMode("custom-theme-choose-mode")?.keymap?.get("return")).toBe("enable-theme")
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
  expect(editor.currentBuffer.text).toContain("Variable: jemacs-customize-direct-flag")
  expect(editor.currentBuffer.text).not.toContain("Variable: jemacs-customize-direct-count")

  await editor.run("customize-saved")
  expect(editor.currentBuffer.text).toContain("Variable: jemacs-customize-direct-count")

  await editor.run("customize-apropos-options", ["direct-count"])
  expect(editor.currentBuffer.text).toContain("Variable: jemacs-customize-direct-count")
  expect(editor.currentBuffer.text).not.toContain("Variable: jemacs-customize-direct-flag")
})

test("customize-set-variable from a Value: line walks back to the enclosing variable", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  defcustom("jemacs-backwalk-a", "boolean", false, "first backwalk option")
  defcustom("jemacs-backwalk-b", "boolean", false, "second backwalk option")

  await editor.run("customize-apropos-options", ["jemacs-backwalk"])
  const text = editor.currentBuffer.text
  expect(text).toContain("Variable: jemacs-backwalk-a")
  expect(text).toContain("Variable: jemacs-backwalk-b")

  const secondHeader = text.indexOf("Variable: jemacs-backwalk-b")
  editor.currentBuffer.point = text.indexOf("  Value:", secondHeader)
  expect(editor.currentBuffer.lineBoundsAt().text.startsWith("  Value:")).toBe(true)

  const setPromise = editor.run("customize-set-variable")
  editor.activeBuffer.setText("true", true)
  editor.minibufferSubmit()
  await setPromise
  expect(getCustom<boolean>("jemacs-backwalk-b")).toBe(true)
  expect(getCustom<boolean>("jemacs-backwalk-a")).toBe(false)
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

test("customize-themes toggles and saves plugin themes", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  installStephenConfig(editor)
  disableBuiltinTheme("gruvbox-dark-hard")
  saveEnabledBuiltinThemes([])

  await editor.run("customize-themes")
  expect(editor.currentBuffer.name).toBe("*Custom Themes*")
  expect(editor.currentBuffer.mode).toBe("custom-theme-choose-mode")
  expect(editor.currentBuffer.text).toContain("Theme: gruvbox-dark-hard [ ]")
  expect(editor.currentBuffer.text).toContain("Source: plugin")

  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("Theme: gruvbox-dark-hard")
  await editor.run("enable-theme")
  expect(isBuiltinThemeEnabled("gruvbox-dark-hard")).toBe(true)
  expect(editor.theme.name).toBe("gruvbox-dark-hard")
  expect(editor.currentBuffer.text).toContain("Theme: gruvbox-dark-hard [X]")

  await editor.run("customize-save-customized")
  expect(listSavedBuiltinThemes()).toContain("gruvbox-dark-hard")

  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("Theme: gruvbox-dark-hard")
  await editor.run("enable-theme")
  expect(isBuiltinThemeEnabled("gruvbox-dark-hard")).toBe(false)
})
