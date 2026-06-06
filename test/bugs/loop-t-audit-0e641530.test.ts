import { expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { getMinorMode } from "../../src/modes/minor-mode"

// t-audit-0e641530: PluginContext was incomplete vs its own spec — no
// minorMode() surface, and command()/key() registered without pushing an
// undo thunk, so dispose() could not tear a plugin down before reload.
// (Fix landed alongside t-audit-2907f4d9; this file pins the literal audit
// claims so a regression on either is caught.)

test("PluginContext exposes minorMode()", () => {
  const editor = new Editor()
  const ctx = createPluginContext(editor)
  // Type-level: minorMode is part of the surface.
  const _surface: keyof PluginContext = "minorMode"
  void _surface
  // Runtime: registers and returns the installed spec.
  const installed = ctx.minorMode({ name: "t-0e641530-mm", lighter: " X" })
  expect(installed.name).toBe("t-0e641530-mm")
  expect(getMinorMode("t-0e641530-mm")?.lighter).toBe(" X")
})

test("ctx.command records an undo thunk so dispose() reverts it", () => {
  const editor = new Editor()
  editor.command("t-0e641530-cmd", () => "base")
  const ctx = createPluginContext(editor)
  ctx.command("t-0e641530-cmd", () => "plugin")
  expect(editor.commands.get("t-0e641530-cmd")?.fn({} as never)).toBe("plugin")
  ctx.dispose()
  expect(editor.commands.get("t-0e641530-cmd")?.fn({} as never)).toBe("base")
})

test("ctx.key records an undo thunk so dispose() reverts it", () => {
  const editor = new Editor()
  editor.defineKey("global-map", "C-c 0 e", "base-cmd")
  const ctx = createPluginContext(editor)
  ctx.key("global-map", "C-c 0 e", "plugin-cmd")
  expect(editor.keymap.get("C-c 0 e")).toBe("plugin-cmd")
  ctx.dispose()
  expect(editor.keymap.get("C-c 0 e")).toBe("base-cmd")
})
