import type { Editor } from "../kernel/editor"
import { Keymap } from "../kernel/keymap"
import { defineMode } from "../modes/mode"
import { xrefFindDefinitionsCommand } from "./find-definitions"
import { xrefGoBack, xrefGoForward } from "./history"

export function installXrefMode(): void {
  const keymap = new Keymap("xref-mode-map")
  keymap.bind("enter", "compile-goto-error")
  keymap.bind("return", "compile-goto-error")
  keymap.bind("C-m", "compile-goto-error")
  keymap.bind("n", "next-error-buffer-next")
  keymap.bind("p", "next-error-buffer-previous")
  keymap.bind("q", "quit-window")
  defineMode({ name: "xref-mode", parent: "text", keymap })
}

export function installXref(editor: Editor): void {
  installXrefMode()

  editor.command("xref-find-definitions", async ({ editor, args, prefixArgument }) => {
    await xrefFindDefinitionsCommand(editor, { identifier: args[0], prefixArgument })
  }, "Find the definition of the identifier at point.")

  editor.command("xref-find-definitions-other-window", async ({ editor, args, prefixArgument }) => {
    editor.displayBufferInOtherWindow(editor.currentBufferId)
    await xrefFindDefinitionsCommand(editor, { identifier: args[0], prefixArgument })
  }, "Find the definition of the identifier at point in another window.")

  editor.command("xref-go-back", ({ editor }) => {
    if (!xrefGoBack(editor)) editor.message("At start of xref history")
  }, "Go back to the previous position in xref history.")

  editor.command("xref-go-forward", ({ editor }) => {
    if (!xrefGoForward(editor)) editor.message("At end of xref history")
  }, "Go forward in xref history after xref-go-back.")

  editor.key("M-.", "xref-find-definitions")
  editor.key("esc .", "xref-find-definitions")
  editor.key("C-x 4 .", "xref-find-definitions-other-window")
  editor.key("M-,", "xref-go-back")
  editor.key("esc ,", "xref-go-back")
  editor.key("M-C-,", "xref-go-forward")
  editor.key("esc C-,", "xref-go-forward")
}
