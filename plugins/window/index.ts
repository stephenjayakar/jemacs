import type { Editor } from "../../src/kernel/editor"
import type { WindowNode } from "../../src/kernel/window"
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

/** Share of its immediate parent split that leaf `id` holds, or null if it is the only window. */
function leafShare(node: WindowNode, id: string): number | null {
  if (node.kind === "leaf") return null
  const first = node.firstRatio ?? 0.5
  if (node.first.kind === "leaf" && node.first.id === id) return first
  if (node.second.kind === "leaf" && node.second.id === id) return 1 - first
  return leafShare(node.first, id) ?? leafShare(node.second, id)
}

// Same step and command names as jwm's ⌘D . / ⌘D ,: grow or shrink the selected window
// by 5% of its parent split. The kernel clamps the share to 10%..90%.
function resizeSelectedWindow(editor: Editor, delta: number): void {
  const id = editor.selectedWindowId
  const share = leafShare(editor.windowLayout, id)
  if (share === null) {
    editor.message("Only one window")
    return
  }
  editor.setWindowSplitRatio(id, share + delta)
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  ctx.command("enlarge-window", ({ editor }) => resizeSelectedWindow(editor, 0.05),
    "Grow the selected window by 5% of its parent split.")
  ctx.command("shrink-window", ({ editor }) => resizeSelectedWindow(editor, -0.05),
    "Shrink the selected window by 5% of its parent split.")
  ctx.key("global-map", "C-x .", "enlarge-window")
  ctx.key("global-map", "C-x ,", "shrink-window")

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
    // quit-window deletes its window through the kernel shim rather than by running
    // `delete-window`, so it needs its own advice to match init.el's auto-balance.
    "quit-window",
  ].map(cmd => ctx.advice(cmd, { after: balanceAfterWindowChange }))
  ctx.onDispose(() => { adviceIds = [] })
}
