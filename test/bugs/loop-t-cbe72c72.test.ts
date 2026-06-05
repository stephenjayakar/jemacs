import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { install, leanUpdateInfo, LEAN_INFO_BUFFER } from "../../plugins/lean4"
import { LspManager } from "../../src/lsp/manager"

// t-cbe72c72: opening Basic.lean leaves the buffer in 'text' — inferMode() has no
// .lean entry and the plugin defines neither a find-file-hook nor an interactive
// lean4-mode command, so font-lock and the lean4-map keymap are never active and
// lean4-toggle-info bails on buffer.mode !== 'lean4'.
test("t-cbe72c72: .lean files auto-enter lean4 via find-file-hook; M-x lean4-mode exists", async () => {
  const editor = makeEditor()
  install(editor)

  expect(editor.commands.get("lean4-mode")).toBeDefined()

  const buffer = editor.scratch("Basic.lean", "theorem t : True := trivial\n", "text")
  buffer.path = "/proj/Basic.lean"
  await editor.runHook("find-file-hook", buffer)
  expect(buffer.mode).toBe("lean4")

  const other = editor.scratch("notes.txt", "", "text")
  await editor.run("lean4-mode")
  expect(other.mode).toBe("lean4")
})

// t-105a898c (merged): with no lean toolchain, no workspace initializes, so
// requestPlainGoal → null → renderGoals(null) → "No goals.", which reads as
// "proof complete". Surface the missing-server condition instead.
test("t-105a898c: *lean-info* says server not connected when no workspace, not 'No goals.'", async () => {
  const editor = makeEditor()
  install(editor)
  editor.lsp = new LspManager(editor)
  const buffer = editor.scratch("Basic.lean", "theorem t : True := trivial\n", "lean4")
  editor.switchToBuffer(buffer.id)

  await leanUpdateInfo(editor, buffer)
  const info = [...editor.buffers.values()].find(b => b.name === LEAN_INFO_BUFFER)
  expect(info).toBeDefined()
  expect(info!.text).not.toBe("No goals.")
  expect(info!.text).toContain("Lean server not connected")
})
