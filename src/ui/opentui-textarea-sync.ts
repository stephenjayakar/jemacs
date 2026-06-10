import { SyntaxStyle, type TextareaRenderable } from "@opentui/core"
import { applyTheme } from "../display/theme"
import type { FaceStyle, Theme } from "../display/theme"
import type { ThemedChunk } from "../display/themed-text"
import type { TextSpan } from "../modes/mode"
import { resolveFace } from "../runtime/faces"

const syntaxByTheme = new WeakMap<Theme, SyntaxStyle>()
const styleIdByChunkKey = new WeakMap<SyntaxStyle, Map<string, number>>()

export function syntaxForTheme(theme: Theme): SyntaxStyle {
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

function chunkHasNonDefaultStyle(chunk: ThemedChunk, defaultStyle: FaceStyle | undefined): boolean {
  return chunk.fg !== defaultStyle?.fg
    || chunk.bg !== defaultStyle?.bg
    || !!chunk.bold !== !!defaultStyle?.bold
    || !!chunk.italic !== !!defaultStyle?.italic
    || !!chunk.underline !== !!defaultStyle?.underline
}

function nativeLength(text: string): number {
  let length = text.length
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) length--
  return length
}

/** Sync full-buffer text, point, and font-lock highlights into a TextareaRenderable. */
export function syncTextareaFromSpans(
  textarea: TextareaRenderable,
  options: { text: string; point: number; spans: TextSpan[]; theme: Theme; selected: boolean },
): void {
  const { editBuffer } = textarea
  editBuffer.setText(options.text)
  editBuffer.clearAllHighlights()
  const defaultStyle = resolveFace("default", options.theme)
  if (defaultStyle?.fg) {
    textarea.textColor = defaultStyle.fg
    textarea.focusedTextColor = defaultStyle.fg
  }
  if (defaultStyle?.bg) {
    textarea.backgroundColor = defaultStyle.bg
    textarea.focusedBackgroundColor = defaultStyle.bg
  }
  const syntax = syntaxForTheme(options.theme)
  editBuffer.setSyntaxStyle(syntax)

  const themed = applyTheme(options.text, options.spans, options.theme)
  let nativeOffset = 0
  for (const chunk of themed.chunks) {
    const nativeEnd = nativeOffset + nativeLength(chunk.text)
    if (chunkHasNonDefaultStyle(chunk, defaultStyle)) {
      editBuffer.addHighlightByCharRange({
        start: nativeOffset,
        end: nativeEnd,
        styleId: styleIdForChunk(syntax, chunk),
      })
    }
    nativeOffset = nativeEnd
  }

  textarea.cursorOffset = options.point
  textarea.showCursor = options.selected
}
