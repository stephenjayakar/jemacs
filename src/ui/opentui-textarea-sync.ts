import { SyntaxStyle, type TextareaRenderable } from "@opentui/core"
import { applyTheme } from "../display/theme"
import type { Theme } from "../display/theme"
import type { ThemedChunk } from "../display/themed-text"
import type { TextSpan } from "../modes/mode"

const syntaxByTheme = new WeakMap<Theme, SyntaxStyle>()
const styleIdByChunkKey = new WeakMap<SyntaxStyle, Map<string, number>>()

function syntaxForTheme(theme: Theme): SyntaxStyle {
  let syntax = syntaxByTheme.get(theme)
  if (!syntax) {
    const styles: Record<string, { fg?: string; bg?: string; bold?: boolean; italic?: boolean; underline?: boolean }> = {}
    for (const [name, face] of Object.entries(theme.faces)) {
      styles[name] = {
        fg: face.fg,
        bg: face.bg,
        bold: face.bold,
        italic: face.italic,
        underline: face.underline,
      }
    }
    syntax = SyntaxStyle.fromStyles(styles)
    syntaxByTheme.set(theme, syntax)
  }
  return syntax
}

function chunkStyleKey(chunk: ThemedChunk): string {
  return [chunk.fg ?? "", chunk.bg ?? "", chunk.bold ? "b" : "", chunk.italic ? "i" : "", chunk.underline ? "u" : ""].join("|")
}

function styleIdForChunk(syntax: SyntaxStyle, chunk: ThemedChunk): number {
  const key = chunkStyleKey(chunk)
  let cache = styleIdByChunkKey.get(syntax)
  if (!cache) {
    cache = new Map()
    styleIdByChunkKey.set(syntax, cache)
  }
  let id = cache.get(key)
  if (id == null) {
    id = syntax.registerStyle(`jemacs-chunk:${cache.size}`, {
      fg: chunk.fg,
      bg: chunk.bg,
      bold: chunk.bold,
      italic: chunk.italic,
      underline: chunk.underline,
    })
    cache.set(key, id)
  }
  return id
}

function chunkHasStyle(chunk: ThemedChunk): boolean {
  return Boolean(chunk.fg || chunk.bg || chunk.bold || chunk.italic || chunk.underline)
}

function newlineOffsets(text: string): number[] {
  const offsets: number[] = []
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    offsets.push(index)
  }
  return offsets
}

function countNewlinesBefore(offsets: number[], offset: number): number {
  let lo = 0
  let hi = offsets.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] < offset) lo = mid + 1
    else hi = mid
  }
  return lo
}

function toNativeHighlightOffset(offsets: number[], offset: number): number {
  return offset - countNewlinesBefore(offsets, offset)
}

/** Sync full-buffer text, point, and font-lock highlights into a TextareaRenderable. */
export function syncTextareaFromSpans(
  textarea: TextareaRenderable,
  options: { text: string; point: number; spans: TextSpan[]; theme: Theme; selected: boolean },
): void {
  const { editBuffer } = textarea
  editBuffer.setText(options.text)
  editBuffer.clearAllHighlights()
  const syntax = syntaxForTheme(options.theme)
  editBuffer.setSyntaxStyle(syntax)

  const themed = applyTheme(options.text, options.spans, options.theme)
  const lineBreaks = newlineOffsets(options.text)
  let offset = 0
  for (const chunk of themed.chunks) {
    const end = offset + chunk.text.length
    if (chunkHasStyle(chunk)) {
      editBuffer.addHighlightByCharRange({
        start: toNativeHighlightOffset(lineBreaks, offset),
        end: toNativeHighlightOffset(lineBreaks, end),
        styleId: styleIdForChunk(syntax, chunk),
      })
    }
    offset = end
  }

  textarea.cursorOffset = options.point
  textarea.showCursor = options.selected
}
