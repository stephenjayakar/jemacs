import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { removeAdvice } from "../../src/runtime/advice"

// Advice is process-global; the handler reads its editor from CommandContext,
// so one registration serves every editor. Track ids so a second install (or
// reload) tears down the prior set instead of stacking.
let adviceIds: string[] = []

function balanceAfterWindowChange({ editor }: { editor: Editor }): void {
  editor.balanceWindows()
}

function splitWindow(editor: Editor, direction: string | undefined): void {
  switch (direction) {
    case "right":
    case "horizontal":
    case "horizontally":
      editor.splitWindowRight()
      return
    case "below":
    case "vertical":
    case "vertically":
    case undefined:
    case "":
      editor.splitWindowBelow()
      return
    default:
      editor.message(`Unknown split direction: ${direction}`)
  }
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  editor.command("balance-windows", ({ editor }) => {
    editor.balanceWindows()
    editor.message("Balanced windows")
  }, "Make all visible windows approximately the same height or width.")

  editor.command("split-window", ({ editor, args }) => {
    splitWindow(editor, args[0])
  }, "Split the selected window. With no direction, split below.")

  editor.command("split-window-horizontally", ({ editor }) => {
    editor.splitWindowRight()
  }, "Split the selected window into two side-by-side windows.")

  editor.command("split-window-vertically", ({ editor }) => {
    editor.splitWindowBelow()
  }, "Split the selected window into two windows, one above the other.")

  editor.key("C-x +", "balance-windows")

  for (const id of adviceIds) removeAdvice(id)
  adviceIds = [
    "split-window",
    "split-window-below",
    "split-window-right",
    "split-window-horizontally",
    "split-window-vertically",
    "delete-window",
  ].map(cmd => ctx.advice(cmd, { after: balanceAfterWindowChange }))
  ctx.onDispose(() => { adviceIds = [] })
}
