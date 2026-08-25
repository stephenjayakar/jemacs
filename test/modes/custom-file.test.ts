/**
 * `custom-file` round trips: what `custom-save-all` writes must load back into
 * the same options, faces, comments, and enabled themes on the next start.
 */
import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Editor } from "../../src/kernel/editor"
import { installDefaultConfig, loadCustomFile, saveCustomFile } from "../../src/config"
import { installDefaultModes } from "../../src/modes/default-modes"
import {
  defcustom,
  defgroup,
  getCustom,
  getCustomVariable,
  resetCustom,
  saveCustom,
  setCustomComment,
} from "../../src/runtime/custom"
import { defface, getCustomFace, resetFace, saveFace, setFaceAttribute } from "../../src/runtime/faces"
import { disableBuiltinTheme, listEnabledBuiltinThemes, saveEnabledBuiltinThemes } from "../../src/themes"
import { install as installGruvbox } from "../../plugins/gruvbox-dark-hard"
import { install as installModus } from "../../plugins/modus-vivendi"

/** A fresh editor with the two bundled themes registered, on a temp custom-file. */
async function customFileEditor(): Promise<{ editor: Editor; evaluator: ReturnType<typeof installDefaultConfig>; path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-custom-file-"))
  const path = join(dir, "custom.ts")
  process.env.JEMACS_CUSTOM_FILE = path
  installDefaultModes()
  const editor = new Editor()
  const evaluator = installDefaultConfig(editor)
  installGruvbox(editor)
  installModus(editor)
  return { editor, evaluator, path, dir }
}

function resetProbeState(): void {
  for (const name of ["cf-count", "cf-list", "cf-noted", "custom-enabled-themes"]) resetCustom(name)
  resetFace("cf-face")
  for (const theme of listEnabledBuiltinThemes()) disableBuiltinTheme(theme)
  saveEnabledBuiltinThemes([])
}

test("a save/restart/load cycle preserves options, faces, comments, and themes", async () => {
  const previous = process.env.JEMACS_CUSTOM_FILE
  const first = await customFileEditor()
  try {
    // Other test files share the theme registry; start from a known state.
    resetProbeState()
    defgroup("editing", "Basic text editing facilities.")
    defcustom("cf-count", "integer", 1, "Count doc.", "editing")
    defcustom("cf-list", { kind: "repeat", item: "string" }, [], "List doc.", "editing")
    defcustom("cf-noted", "string", "plain", "Noted doc.", "editing")
    defface("cf-face", {}, "CF face doc.", "editing")

    saveCustom("cf-count", 42)
    saveCustom("cf-list", ["x", "y"])
    setCustomComment("cf-noted", "why this is set")
    saveCustom("cf-noted", "changed")
    setFaceAttribute("cf-face", "fg", "#abcdef")
    saveFace("cf-face")
    await first.editor.run("enable-theme", ["gruvbox-dark-hard"])
    await first.editor.run("custom-theme-save")

    const written = await readFile(first.path, "utf8")
    expect(written).toContain("customSetVariables(")
    expect(written).toContain('  ["cf-count", 42],')
    expect(written).toContain('  ["cf-list", ["x","y"]],')
    expect(written).toContain('  ["cf-noted", "changed", "why this is set"],')
    expect(written).toContain('customSetFaces(\n  ["cf-face", {"fg":"#abcdef"}],\n)')
    expect(written).toContain('enableBuiltinTheme("gruvbox-dark-hard")')

    // "Restart": drop the session's customizations, then load the file back.
    resetProbeState()
    const second = await customFileEditor()
    process.env.JEMACS_CUSTOM_FILE = first.path
    defcustom("cf-count", "integer", 1, "Count doc.", "editing")
    defcustom("cf-list", { kind: "repeat", item: "string" }, [], "List doc.", "editing")
    defcustom("cf-noted", "string", "plain", "Noted doc.", "editing")
    defface("cf-face", {}, "CF face doc.", "editing")
    await loadCustomFile(second.editor, second.evaluator)

    expect(getCustom<number>("cf-count")).toBe(42)
    expect(getCustom<string[]>("cf-list")).toEqual(["x", "y"])
    expect(getCustom<string>("cf-noted")).toBe("changed")
    expect(getCustomVariable("cf-noted")?.comment).toBe("why this is set")
    expect(getCustomFace("cf-face")?.spec.fg).toBe("#abcdef")
    expect(listEnabledBuiltinThemes()).toContain("gruvbox-dark-hard")
    expect(second.editor.theme.name).toBe("gruvbox-dark-hard")

    // The Custom buffer shows them as saved, not merely set.
    await second.editor.run("customize-variable", ["cf-count"])
    expect(second.editor.currentBuffer.text).toContain("[ State ]: SAVED and set.")
    expect(second.editor.currentBuffer.text).toContain("Hide Cf Count: Integer: 42")
    await rm(second.dir, { recursive: true, force: true })
  } finally {
    resetProbeState()
    if (previous == null) delete process.env.JEMACS_CUSTOM_FILE
    else process.env.JEMACS_CUSTOM_FILE = previous
    await rm(first.dir, { recursive: true, force: true })
  }
})

test("an existing hand-written custom.ts using enableBuiltinTheme still loads", async () => {
  const previous = process.env.JEMACS_CUSTOM_FILE
  const { editor, evaluator, path, dir } = await customFileEditor()
  try {
    // The format `customize-save-customized' wrote before customSetVariables
    // existed; a real user file must keep working across the upgrade.
    await writeFile(path, [
      "// Generated by customize-save-customized — edits may be overwritten.",
      "",
      'enableBuiltinTheme("modus-vivendi")',
      'setFaceAttribute("default", "family", "Fira Code, monospace")',
      "",
    ].join("\n"))
    await loadCustomFile(editor, evaluator)
    expect(listEnabledBuiltinThemes()).toContain("modus-vivendi")
    expect(editor.theme.name).toBe("modus-vivendi")
    expect(getCustomFace("default")?.spec.family).toBe("Fira Code, monospace")
  } finally {
    resetProbeState()
    resetFace("default")
    if (previous == null) delete process.env.JEMACS_CUSTOM_FILE
    else process.env.JEMACS_CUSTOM_FILE = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test("the user's real ~/.jemacs/custom.ts loads without error", async () => {
  const previous = process.env.JEMACS_CUSTOM_FILE
  const real = join(homedir(), ".jemacs", "custom.ts")
  let content: string
  try {
    content = await readFile(real, "utf8")
  } catch {
    return // No user file on this machine; nothing to check.
  }
  const { editor, evaluator, path, dir } = await customFileEditor()
  try {
    await writeFile(path, content)
    await loadCustomFile(editor, evaluator)
    // Loading must not throw, and any themes it enables must resolve.
    for (const theme of listEnabledBuiltinThemes()) {
      expect(typeof theme).toBe("string")
    }
    expect(editor.theme.name).toBeTruthy()
  } finally {
    resetProbeState()
    if (previous == null) delete process.env.JEMACS_CUSTOM_FILE
    else process.env.JEMACS_CUSTOM_FILE = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test("saveCustomFile does not write to the real custom file during tests", async () => {
  // The preload sets JEMACS_CUSTOM_FILE, which every save must honour.
  expect(process.env.JEMACS_CUSTOM_FILE).toBeTruthy()
  expect(process.env.JEMACS_CUSTOM_FILE).not.toBe(join(homedir(), ".jemacs", "custom.ts"))
  await saveCustomFile()
  const written = await readFile(process.env.JEMACS_CUSTOM_FILE!, "utf8")
  expect(written).toContain("Generated by Custom")
})
