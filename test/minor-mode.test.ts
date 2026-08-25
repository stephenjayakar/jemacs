import { expect, test } from "bun:test"
import { Editor } from "../src/kernel/editor"
import { Keymap } from "../src/kernel/keymap"
import { installDefaultConfig } from "../src/config"
import { install as installStephenConfig } from "./fixtures/stephen-config"
import { installDefaultModes } from "../src/modes/default-modes"
import { defineMinorMode } from "../src/modes/minor-mode"
import { setCustom } from "../src/runtime/custom"
import { formatWithLineNumbers, mapVisibleOffset } from "../src/ui/line-numbers"
import { visibleStyledText, visibleStyledTextFromStart } from "../src/ui/opentui"
import { defaultTheme } from "../src/themes"

test("minor mode keymaps take precedence over major and global maps", () => {
  installDefaultModes()
  const testMap = new Keymap("test-minor-map")
  testMap.bind("C-c t", "describe-mode")
  defineMinorMode({ name: "test-minor", keymap: testMap })
  const editor = new Editor()
  installDefaultConfig(editor)
  editor.keymap.bind("C-c t", "save-buffer")
  editor.scratch("minor-test", "", "text")
  editor.enableMinorMode("test-minor")

  const result = editor.keymaps.lookup("C-c t")
  expect(result.status).toBe("matched")
  if (result.status === "matched") {
    expect(result.command).toBe("describe-mode")
    expect(result.mapName).toBe("test-minor-map")
  }
})

test("Stephen config enables linum-mode and vertico-mode", async () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  await installStephenConfig(editor)
  expect(editor.isMinorModeEnabled("linum-mode")).toBe(true)
  expect(editor.isMinorModeEnabled("vertico-mode")).toBe(true)
  expect(editor.showLineNumbers()).toBe(true)
  expect(editor.keymap.get("C-x l")).toBe("goto-line")
  expect(editor.minorModeLighters()).toContain("Lin")
  expect(editor.minorModeLighters()).toContain("Vertico")
})

test("linum-mode command toggles line numbers", async () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  editor.enableMinorMode("linum-mode")
  await editor.run("linum-mode")
  expect(editor.isMinorModeEnabled("linum-mode")).toBe(false)
  await editor.run("linum-mode")
  expect(editor.isMinorModeEnabled("linum-mode")).toBe(true)
})

test("display-line-numbers-mode command toggles line numbers", async () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  await editor.run("display-line-numbers-mode")
  expect(editor.isMinorModeEnabled("display-line-numbers-mode")).toBe(true)
  expect(editor.showLineNumbers()).toBe(true)
  await editor.run("display-line-numbers-mode")
  expect(editor.isMinorModeEnabled("display-line-numbers-mode")).toBe(false)
})

test("linum-mode formats a line number gutter", () => {
  const format = formatWithLineNumbers("alpha\nbeta", 1)
  expect(format.text).toBe("1  alpha\n2  beta")
  expect(mapVisibleOffset(0, "alpha\nbeta", format.prefixLen)).toBe(format.prefixLen)
  const styled = visibleStyledText("alpha\nbeta", "alpha".length, { theme: defaultTheme, maxLines: 10, showLineNumbers: true })
  const rendered = styled.chunks.map(chunk => chunk.text).join("")
  expect(rendered).toContain("1  alpha")
  expect(rendered).toContain("2  beta")
})

test("display-line-numbers-type relative shows distance and absolute current line", () => {
  installDefaultModes()
  const format = formatWithLineNumbers("alpha\nbeta\ngamma\ndelta\nepsilon", 1, "relative", 3)
  expect(format.text).toBe("2  alpha\n1  beta\n3  gamma\n1  delta\n2  epsilon")

  setCustom("display-line-numbers-type", "relative")
  const point = "alpha\nbeta\n".length
  const styled = visibleStyledTextFromStart("alpha\nbeta\ngamma\ndelta\nepsilon", point, 0, {
    theme: defaultTheme,
    maxLines: 10,
    showLineNumbers: true,
    showCursor: true,
  })
  const rendered = styled.chunks.map(chunk => chunk.text).join("")
  expect(rendered).toContain("2  alpha")
  expect(rendered).toContain("1  beta")
  // The block cursor glyph replaces the character under point.
  expect(rendered).toContain("3  █amma")
  expect(rendered).toContain("1  delta")
  setCustom("display-line-numbers-type", true)
})
