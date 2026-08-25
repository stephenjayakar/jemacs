import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import type { FaceName, TextSpan } from "../../src/modes/mode"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defvar, getCustom } from "../../src/runtime/custom"
import { defface } from "../../src/runtime/faces"

export const WHITESPACE_TRAILING_FACE = "whitespace-trailing" as FaceName
export const WHITESPACE_TAB_FACE = "whitespace-tab" as FaceName
export const WHITESPACE_LINE_FACE = "whitespace-line" as FaceName
export const HL_LINE_FACE = "hl-line" as FaceName

const FILL_COLUMN_LOCAL = "fill-column"

type LineInfo = { start: number; end: number; text: string }

function whitespaceEnabled(editor: Editor, buffer: BufferModel): boolean {
  return editor.isMinorModeEnabled("whitespace-mode", buffer)
    || editor.isMinorModeEnabled("global-whitespace-mode", buffer)
}

function currentFillColumn(buffer: BufferModel): number {
  const local = buffer.locals.get(FILL_COLUMN_LOCAL)
  const column = typeof local === "number" ? local : getCustom<number>("fill-column") ?? 80
  return Number.isFinite(column) ? Math.max(1, Math.floor(column)) : 80
}

function forEachLine(text: string, fn: (line: LineInfo) => void): void {
  let start = 0
  while (start <= text.length) {
    const newline = text.indexOf("\n", start)
    const end = newline === -1 ? text.length : newline
    fn({ start, end, text: text.slice(start, end) })
    if (newline === -1) break
    start = newline + 1
  }
}

function facePriority(face: FaceName): number {
  if (face === WHITESPACE_LINE_FACE) return 0
  if (face === WHITESPACE_TAB_FACE) return 1
  if (face === WHITESPACE_TRAILING_FACE) return 2
  return 3
}

export function whitespaceSpans(buffer: BufferModel, editor: Editor): TextSpan[] {
  if (!whitespaceEnabled(editor, buffer)) return []

  const spans: TextSpan[] = []
  const fillColumn = currentFillColumn(buffer)
  forEachLine(buffer.text, line => {
    if (line.text.length > fillColumn) {
      spans.push({ start: line.start + fillColumn, end: line.end, face: WHITESPACE_LINE_FACE })
    }

    for (let index = line.text.indexOf("\t"); index !== -1; index = line.text.indexOf("\t", index + 1)) {
      spans.push({ start: line.start + index, end: line.start + index + 1, face: WHITESPACE_TAB_FACE })
    }

    const trailing = /[ \t]+$/.exec(line.text)
    if (trailing?.[0]) {
      spans.push({
        start: line.start + trailing.index,
        end: line.end,
        face: WHITESPACE_TRAILING_FACE,
      })
    }
  })

  return spans.sort((a, b) =>
    a.start - b.start || a.end - b.end || facePriority(a.face) - facePriority(b.face),
  )
}

export function hlLineSpans(buffer: BufferModel, editor: Editor): TextSpan[] {
  if (!editor.isMinorModeEnabled("hl-line-mode", buffer)) return []
  const line = buffer.lineBoundsAt()
  if (line.start >= line.end) return []
  return [{ start: line.start, end: line.end, face: HL_LINE_FACE }]
}

function toggleBufferMinorMode(editor: Editor, buffer: BufferModel, mode: string, prefixArgument?: number | null): void {
  if (prefixArgument != null && prefixArgument > 0) editor.enableMinorMode(mode, { buffer })
  else if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode(mode, { buffer })
  else editor.toggleMinorMode(mode, { buffer })
}

function toggleGlobalMinorMode(editor: Editor, mode: string, prefixArgument?: number | null): void {
  if (prefixArgument != null && prefixArgument > 0) editor.enableMinorMode(mode)
  else if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode(mode)
  else editor.toggleMinorMode(mode)
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defface("whitespace-trailing", { bg: "#7a2f2f", fg: "#ffe5e5" },
    "Face for trailing whitespace.", "whitespace")
  defface("whitespace-tab", { bg: "#263541", fg: "#9fb3c8" },
    "Face for tab characters.", "whitespace")
  defface("whitespace-line", { bg: "#4a3a1f", fg: "#f0d28a" },
    "Face for text past `fill-column`.", "whitespace")
  defface("hl-line", { bg: "#283241" },
    "Face for highlighting the current line.", "whitespace")

  const overlayEditors = defvar("whitespace--overlay-editors", new WeakSet<Editor>(),
    "Editors that have registered the whitespace overlay source.", "whitespace").value
  if (!overlayEditors.has(editor)) {
    editor.addOverlaySource(buffer => [
      ...hlLineSpans(buffer, editor),
      ...whitespaceSpans(buffer, editor),
    ])
    overlayEditors.add(editor)
  }

  ctx.minorMode({ name: "whitespace-mode", lighter: " WS" })
  ctx.minorMode({ name: "global-whitespace-mode", lighter: " WS", global: true })
  ctx.minorMode({ name: "hl-line-mode", lighter: " Hl" })

  ctx.command("whitespace-mode", ({ editor, buffer, prefixArgument }) => {
    toggleBufferMinorMode(editor, buffer, "whitespace-mode", prefixArgument)
  }, "Toggle visualization of whitespace in the current buffer.")

  ctx.command("global-whitespace-mode", ({ editor, prefixArgument }) => {
    toggleGlobalMinorMode(editor, "global-whitespace-mode", prefixArgument)
  }, "Toggle visualization of whitespace in all buffers.")

  ctx.command("hl-line-mode", ({ editor, buffer, prefixArgument }) => {
    toggleBufferMinorMode(editor, buffer, "hl-line-mode", prefixArgument)
  }, "Toggle highlighting of the current line.")
}
