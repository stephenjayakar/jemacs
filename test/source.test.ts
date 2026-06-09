import { expect, test } from "bun:test"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig as installDefaultCommands } from "../src/config"
import { installDefaultModes } from "../src/modes/default-modes"
import { defcustom, getCustom, patchCustom, restoreCustom } from "../src/runtime/custom"
import {
  commandNameFromForm,
  extractTopLevelForm,
  formatDescribeFunction,
  parseSourceLineAtPoint,
} from "../src/runtime/source"
import { definitionRefFromForm } from "../src/runtime/definitions"
import { HELP_TOPIC_KEY } from "../src/runtime/live-source"
import { getKeyBinding } from "../src/runtime/key-registry"

function boot(editor: Editor): void {
  installDefaultModes()
  installDefaultCommands(editor)
}

test("commands record source locations from install site", () => {
  const editor = new Editor()
  boot(editor)
  const spec = editor.commands.get("save-buffer")
  expect(spec?.source?.file).toContain("lisp/files.ts")
  expect(spec?.source?.line).toBeGreaterThan(0)
})

test("key bindings record source from default-bindings", () => {
  const editor = new Editor()
  boot(editor)
  const binding = getKeyBinding("global-map", "C-x C-s")
  expect(binding?.command).toBe("save-buffer")
  expect(binding?.source?.file).toContain("default-bindings.ts")
})

test("describe-function includes source line and help topic", async () => {
  const editor = new Editor()
  boot(editor)
  await editor.run("describe-function", ["save-buffer"])
  const help = editor.currentBuffer
  expect(help.name).toBe("*Help*")
  expect(help.mode).toBe("help")
  expect(help.text).toContain("Source:")
  expect(help.locals.get(HELP_TOPIC_KEY)).toEqual({ kind: "command", name: "save-buffer" })
})

test("describe-variable shows custom variable source", async () => {
  const editor = new Editor()
  boot(editor)
  await editor.run("describe-variable", ["transient-mark-mode"])
  expect(editor.currentBuffer.text).toContain("transient-mark-mode")
  expect(editor.currentBuffer.text).toContain("Source:")
})

test("patch and restore command implementations", () => {
  const editor = new Editor()
  boot(editor)
  const spec = editor.commands.get("save-buffer")!
  const baseline = spec.fn
  editor.commands.patch("save-buffer", async () => {}, spec.source)
  expect(spec.patched).toBe(true)
  expect(spec.fn).not.toBe(baseline)
  editor.commands.restore("save-buffer")
  expect(spec.fn).toBe(baseline)
})

test("custom variables patch and restore", () => {
  defcustom("test-patch-var", "boolean", false, "test")
  patchCustom("test-patch-var", true)
  expect(getCustom("test-patch-var")).toBe(true)
  restoreCustom("test-patch-var")
  expect(getCustom("test-patch-var")).toBe(false)
})

test("extractTopLevelForm finds editor.command call", () => {
  const text = `// preamble
editor.command("demo", ({ editor }) => {
  editor.message("hi")
}, "Demo")
`
  const point = text.indexOf("editor.message")
  const region = extractTopLevelForm(text, point)
  expect(region?.text).toContain('editor.command("demo"')
  expect(commandNameFromForm(region!.text)).toBe("demo")
  expect(definitionRefFromForm(region!.text)?.kind).toBe("command")
})

test("definitionRefFromForm detects defcustom", () => {
  const ref = definitionRefFromForm('defcustom("my-var", "boolean", true, "doc")')
  expect(ref).toEqual({ kind: "variable", name: "my-var" })
})

test("parseSourceLineAtPoint reads Source lines", () => {
  const text = "describe-function\n\nSource: /tmp/foo.ts:12:3\n"
  const point = text.indexOf("/tmp")
  const source = parseSourceLineAtPoint(text, point)
  expect(source).toEqual({ file: "/tmp/foo.ts", line: 12, column: 3 })
})

test("formatDescribeFunction shows patch status", () => {
  const editor = new Editor()
  boot(editor)
  const spec = editor.commands.get("save-buffer")!
  editor.commands.patch("save-buffer", spec.fn, spec.source)
  const body = formatDescribeFunction(spec)
  expect(body).toContain("temporarily patched")
})

test("live source extension commands use Jemacs names", () => {
  const editor = new Editor()
  boot(editor)
  expect(editor.commands.get("find-definition")).toBeUndefined()
  expect(editor.commands.get("revert-function")).toBeUndefined()
  expect(editor.commands.get("revert-definition")).toBeUndefined()
  expect(editor.commands.get("revert-all-definitions")).toBeUndefined()
  expect(editor.commands.get("jemacs-find-definition")).toBeDefined()
  expect(editor.commands.get("jemacs-revert-function")).toBeDefined()
  expect(editor.commands.get("jemacs-revert-definition")).toBeDefined()
  expect(editor.commands.get("jemacs-revert-all-definitions")).toBeDefined()
})
