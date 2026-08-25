import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { getMode } from "../../src/modes/mode"
import { defcustom, getCustom, getCustomVariable, resetCustom } from "../../src/runtime/custom"

// t-84506ffb: the *Customize* buffer advertised keys that customize-mode-map did
// not bind, and no reset/refresh commands existed, so the keys were dead.
// The buffer now carries cus-edit.el's real widgets, so the check is that every
// binding in custom-mode-map resolves to a command and the reset paths work.
test("customize-mode: every custom-mode-map binding resolves to a real command", async () => {
  const editor = makeEditor()
  defcustom("jemacs-t84506ffb-flag", "boolean", false, "t-84506ffb test option")

  await editor.run("customize-variable", ["jemacs-t84506ffb-flag"])
  const keymap = getMode("customize-mode")!.keymap!
  for (const [key, command] of keymap.all()) {
    expect(editor.commands.get(command), `${key} is bound to '${command}' which is not a command`).toBeDefined()
  }
  // cus-edit.el binds C-c C-c / C-x C-s for set/save and q to leave the buffer.
  expect(keymap.get("C-c C-c")).toBe("Custom-set")
  expect(keymap.get("C-x C-s")).toBe("Custom-save")
  expect(keymap.get("q")).toBe("Custom-buffer-done")
  expect(keymap.get("u")).toBe("Custom-goto-parent")
  expect(keymap.get("H")).toBe("custom-toggle-hide-all-widgets")

  // Custom-reset-standard: set, reset, observe the standard value restored.
  await editor.run("customize-set-variable", ["jemacs-t84506ffb-flag", "true"])
  expect(getCustom<boolean>("jemacs-t84506ffb-flag")).toBe(true)
  await editor.run("Custom-reset-standard")
  expect(getCustom<boolean>("jemacs-t84506ffb-flag")).toBe(false)
  expect(getCustomVariable("jemacs-t84506ffb-flag")?.customized).toBe(false)
  expect(editor.currentBuffer.text).toContain("[ State ]: STANDARD.")

  // Custom-reset-saved: save true, set false, revert to the saved value.
  await editor.run("customize-save-variable", ["jemacs-t84506ffb-flag", "true"])
  await editor.run("customize-set-variable", ["jemacs-t84506ffb-flag", "false"])
  expect(getCustom<boolean>("jemacs-t84506ffb-flag")).toBe(false)
  await editor.run("Custom-reset-saved")
  expect(getCustom<boolean>("jemacs-t84506ffb-flag")).toBe(true)
  expect(editor.currentBuffer.text).toContain("[ State ]: SAVED and set.")

  // Reverting the buffer keeps us in the Custom buffer.
  await editor.run("customize-refresh")
  expect(editor.currentBuffer.name).toBe("*Customize Option: Jemacs T84506ffb Flag*")

  resetCustom("jemacs-t84506ffb-flag")
})
