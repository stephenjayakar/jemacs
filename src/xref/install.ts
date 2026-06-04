import type { Editor } from "../kernel/editor"
import { xrefFindDefinitionsCommand } from "./find-definitions"
import { xrefGoBack, xrefGoForward } from "./history"

export function installXref(editor: Editor): void {
  editor.command("xref-find-definitions", async ({ editor, args, prefixArgument }) => {
    await xrefFindDefinitionsCommand(editor, { identifier: args[0], prefixArgument })
  }, "Find the definition of the identifier at point.")

  editor.command("xref-go-back", ({ editor }) => {
    if (!xrefGoBack(editor)) editor.message("At start of xref history")
  }, "Go back to the previous position in xref history.")

  editor.command("xref-go-forward", ({ editor }) => {
    if (!xrefGoForward(editor)) editor.message("At end of xref history")
  }, "Go forward in xref history after xref-go-back.")

  editor.key("M-.", "xref-find-definitions")
  editor.key("esc .", "xref-find-definitions")
  editor.key("M-,", "xref-go-back")
  editor.key("esc ,", "xref-go-back")
  editor.key("M-C-,", "xref-go-forward")
  editor.key("esc C-,", "xref-go-forward")
}
