import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig } from "../src/config"
import { defcustom, getCustom, setCustom } from "../src/runtime/custom"
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
  const promise = editor.prompt("Choose: ", "", undefined, { collection: ["alpha", "alphabet", "beta"] })
  editor.activeBuffer.setText("al", true)
  await editor.refreshMinibufferCompletions()
  const completions = [...editor.buffers.values()].find(b => b.name === "*vertico*")
  expect(completions?.text).toContain("alpha")
  expect(completions?.text).toContain("alphabet")
  await editor.run("vertico-next")
  editor.minibufferSubmit()
  await expect(promise).resolves.toBe("alphabet")
})

test("vertico-mode can be disabled to use icomplete candidates", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
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

test("toggle-transient-mark-mode flips movement deactivation", async () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  setTransientMarkModeEnabled(true)
  const buffer = editor.currentBuffer
  buffer.setText("abcdef", false)
  buffer.setMark()
  buffer.move(1)
  expect(buffer.markActive).toBe(false)

  await editor.run("toggle-transient-mark-mode")
  buffer.setMark()
  buffer.move(1)
  expect(buffer.markActive).toBe(true)
})
