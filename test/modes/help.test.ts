import { expect, test } from "bun:test"
import { installDefaultConfig } from "../../src/config"
import { Editor } from "../../src/kernel/editor"
import { installDefaultModes } from "../../src/modes/default-modes"
import { getMode } from "../../src/modes/mode"
import { HELP_BUTTONS_KEY, type HelpButton } from "../../src/modes/help"
import { HELP_TOPIC_KEY } from "../../src/runtime/live-source"

function boot(): Editor {
  const editor = new Editor()
  installDefaultModes()
  installDefaultConfig(editor)
  return editor
}

test("describe-function help buttonizes known command names", async () => {
  const editor = boot()
  editor.command("test-help-button-source", async () => {}, "See save-buffer for saving files.")

  await editor.run("describe-function", ["test-help-button-source"])

  const buttons = editor.currentBuffer.locals.get(HELP_BUTTONS_KEY) as HelpButton[]
  const save = buttons.find(button => button.name === "save-buffer")
  expect(save).toBeDefined()
  expect(editor.currentBuffer.text.slice(save!.start, save!.end)).toBe("save-buffer")
})

test("help-mode binds quit, revert, and history keys", () => {
  boot()
  const keymap = getMode("help")?.keymap

  expect(keymap?.get("q")).toBe("quit-window")
  expect(keymap?.get("g")).toBe("help-revert")
  expect(keymap?.get("l")).toBe("help-go-back")
  expect(keymap?.get("r")).toBe("help-go-forward")
})

test("TAB moves point to the next help button", async () => {
  const editor = boot()
  editor.command("test-help-tab-source", async () => {}, "See save-buffer for saving files.")
  await editor.run("describe-function", ["test-help-tab-source"])

  const target = editor.currentBuffer.text.indexOf("save-buffer")
  editor.currentBuffer.point = target - 1
  await editor.run("forward-button")

  expect(editor.currentBuffer.point).toBe(target)
})

test("RET follows a help symbol button and l goes back", async () => {
  const editor = boot()
  editor.command("test-help-follow-source", async () => {}, "See save-buffer for saving files.")
  await editor.run("describe-function", ["test-help-follow-source"])

  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("save-buffer")
  await editor.run("help-follow")

  expect(editor.currentBuffer.locals.get(HELP_TOPIC_KEY)).toEqual({ kind: "command", name: "save-buffer" })
  expect(editor.currentBuffer.text.startsWith("save-buffer")).toBe(true)

  await editor.run("help-go-back")

  expect(editor.currentBuffer.locals.get(HELP_TOPIC_KEY)).toEqual({ kind: "command", name: "test-help-follow-source" })
  expect(editor.currentBuffer.text.startsWith("test-help-follow-source")).toBe(true)
})
