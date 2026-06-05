import type { Editor } from "../../src/kernel/editor"
import { addAdvice } from "../../src/runtime/advice"

const advisedEditors = new WeakSet<Editor>()

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

export function install(editor: Editor): void {
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

  editor.command("tiling-cycle", ({ editor }) => editor.message(`Layout ${editor.cycleTilingLayout()}`),
    "Cycle Jemacs tiling layouts.")

  editor.key("C-x +", "balance-windows")
  editor.key("C-\\", "tiling-cycle")

  if (advisedEditors.has(editor)) return
  advisedEditors.add(editor)
  for (const command of [
    "split-window",
    "split-window-below",
    "split-window-right",
    "split-window-horizontally",
    "split-window-vertically",
    "delete-window",
  ]) {
    addAdvice(command, { after: balanceAfterWindowChange })
  }
}
