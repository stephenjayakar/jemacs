import type { BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { Keymap } from "../../src/kernel/keymap"
import type { FaceName, TextSpan } from "../../src/modes/mode"
import { defface } from "../../src/runtime/faces"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"

const MODE = "rectangle-mark-mode"

export const RECTANGLE_PREVIEW_FACE = "rectangle-preview" as FaceName

defface("rectangle-preview", { bg: "#504945" }, "Face for the region-rectangle in rectangle-mark-mode.")

/** Per-line spans covering the rectangle between mark and point. */
export function rectangleRegionSpans(buffer: BufferModel): TextSpan[] {
  if (!buffer.minorModes.has(MODE) || buffer.mark == null) return []
  const start = Math.min(buffer.mark, buffer.point)
  const end = Math.max(buffer.mark, buffer.point)
  const startCol = start - (buffer.text.lastIndexOf("\n", start - 1) + 1)
  const endCol = end - (buffer.text.lastIndexOf("\n", end - 1) + 1)
  const colA = Math.min(startCol, endCol)
  const colB = Math.max(startCol, endCol)
  const startLine = buffer.lineAt(start)
  const endLine = buffer.lineAt(end)
  const spans: TextSpan[] = []
  for (let line = startLine; line <= endLine; line++) {
    const lineStart = buffer.lineStarts[line]!
    const lineEnd = line + 1 < buffer.lineCount ? buffer.lineStarts[line + 1]! - 1 : buffer.text.length
    const lineLen = lineEnd - lineStart
    const from = lineStart + Math.min(colA, lineLen)
    const to = lineStart + Math.min(colB, lineLen)
    if (to > from) spans.push({ start: from, end: to, face: RECTANGLE_PREVIEW_FACE })
  }
  return spans
}

function disableIfActive(editor: Editor, buffer: BufferModel | null | undefined): void {
  if (buffer?.minorModes.has(MODE)) editor.disableMinorMode(MODE, { buffer })
}

/** True when a delete command should operate on the region-rectangle instead of a character. */
function shouldDeleteRectangle(buffer: BufferModel | null | undefined, prefixArgument: number | null | undefined): boolean {
  if (!buffer?.minorModes.has(MODE)) return false
  // Emacs only substitutes the region for a plain (count 1) delete.
  if (prefixArgument != null && prefixArgument !== 1) return false
  return buffer.mark != null && buffer.mark !== buffer.point
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const map = new Keymap("rectangle-mark-mode-map")
  // Emacs rect.el remaps the linear region commands onto their rectangle
  // counterparts while the mode is active.
  map.bind("C-w", "kill-rectangle")
  map.bind("M-w", "copy-rectangle-as-kill")
  map.bind("C-d", "delete-rectangle")
  map.bind("C-t", "string-rectangle")
  map.bind("C-x C-x", "rectangle-exchange-point-and-mark")

  ctx.minorMode({
    name: MODE,
    lighter: " Rect",
    keymap: map,
    onEnable: (_ed, buffer) => {
      if (!buffer) return
      if (buffer.mark == null) buffer.mark = buffer.point
      // The rectangle overlay replaces the linear region display.
      buffer.markActive = false
    },
  })

  editor.addOverlaySource(rectangleRegionSpans)

  ctx.command("rectangle-mark-mode", ({ editor, buffer, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode(MODE, { buffer })
    else if (prefixArgument != null) editor.enableMinorMode(MODE, { buffer })
    else editor.toggleMinorMode(MODE, { buffer })
    if (buffer.minorModes.has(MODE)) editor.message("Mark set (rectangle mode)")
  }, "Toggle marking a rectangular region between point and mark.")

  ctx.command("rectangle-exchange-point-and-mark", ({ buffer, editor }) => {
    if (buffer.mark == null) {
      editor.message("No mark set in this buffer")
      return
    }
    const mark = buffer.mark
    buffer.mark = buffer.point
    buffer.point = mark
  }, "Swap point and mark while keeping the region-rectangle.")

  // In Emacs, rect.el advises `region-extract-function`, so the commands that delete
  // the active region (backspace, delete) remove the region-rectangle instead of a
  // single character. Advise the commands rather than binding keys so any binding that
  // reaches them behaves the same.
  for (const cmd of ["delete-backward-char", "delete-char"]) {
    ctx.advice(cmd, {
      around: async (inner, context) => {
        if (!shouldDeleteRectangle(context.buffer, context.prefixArgument)) return inner(context)
        return context.editor.run("delete-rectangle")
      },
    })
  }

  // The rectangle edit commands clear the mark; end the mode with them, and
  // let C-g cancel the rectangle the same way it deactivates the region.
  for (const cmd of ["kill-rectangle", "copy-rectangle-as-kill", "delete-rectangle", "clear-rectangle", "open-rectangle", "string-rectangle", "string-insert-rectangle", "yank-rectangle", "keyboard-quit"]) {
    ctx.advice(cmd, { after: ({ editor, buffer }) => disableIfActive(editor, buffer) })
  }

  editor.key("C-x space", "rectangle-mark-mode")
}
