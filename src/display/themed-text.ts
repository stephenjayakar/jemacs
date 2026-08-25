import type { FaceStyle } from "./theme"
import { faceStyleHasVisual } from "./theme-types"

export type ThemedChunk = {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  family?: string
  height?: number
  heightScale?: number
}

export type ThemedText = {
  chunks: ThemedChunk[]
}

export function chunkHasStyle(chunk: ThemedChunk): boolean {
  return faceStyleHasVisual(chunk)
}

export function plainThemedText(text: string, style?: FaceStyle): ThemedText {
  if (!faceStyleHasVisual(style)) return { chunks: [{ text }] }
  return { chunks: [{ text, ...styleToChunk(style) }] }
}

export function styleToChunk(style?: FaceStyle): Omit<ThemedChunk, "text"> {
  if (!style) return {}
  return {
    fg: style.fg,
    bg: style.bg,
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    family: style.family,
    height: style.height,
    heightScale: style.heightScale,
  }
}

/** Force `italic: false` on the single character at `offset`, splitting the
 *  chunk that contains it.
 *
 *  Char-grid hosts draw the cursor as a `█` inserted into the text, so it picks
 *  up whatever face is under point. In an italic face (comments, markdown
 *  emphasis) the block is slanted, which reads as a rendering glitch rather
 *  than a cursor. */
export function unitalicizeCharAt(model: ThemedText, offset: number): ThemedText {
  if (offset < 0) return model
  const chunks: ThemedChunk[] = []
  let pos = 0
  let done = false
  for (const chunk of model.chunks) {
    const end = pos + chunk.text.length
    if (done || !chunk.italic || offset < pos || offset >= end) {
      chunks.push(chunk)
      pos = end
      continue
    }
    const i = offset - pos
    if (i > 0) chunks.push({ ...chunk, text: chunk.text.slice(0, i) })
    chunks.push({ ...chunk, text: chunk.text.slice(i, i + 1), italic: false })
    if (i + 1 < chunk.text.length) chunks.push({ ...chunk, text: chunk.text.slice(i + 1) })
    done = true
    pos = end
  }
  return { chunks }
}

export function themedTextPlain(model: ThemedText): string {
  return model.chunks.map(c => c.text).join("")
}

/** Cursor placeholder the char-grid layout inserts into body text. */
export const CURSOR_GLYPH = "\u2588"

/** Pull a `CURSOR_GLYPH` back out of a laid-out body and report where it sat.
 *
 *  Char-grid hosts draw the cursor as a block glyph in the text, which is wrong
 *  on a DOM host: inside a height-scaled heading or a variable-pitch face the
 *  block is a different size than the caret should be, and it displaces the
 *  character it overlays. Hosts with real font metrics instead get a
 *  `(row, colOffset)` and position a caret element themselves. Extracting the
 *  marker *after* layout keeps wrapping and row-budget math on the one code
 *  path both host families share. */
export function extractCursorMarker(
  model: ThemedText,
  marker: string = CURSOR_GLYPH,
): { text: ThemedText; cursor: { row: number; colOffset: number } } | null {
  const chunks: ThemedChunk[] = []
  let cursor: { row: number; colOffset: number } | null = null
  let row = 0
  let col = 0
  for (const chunk of model.chunks) {
    if (cursor) {
      chunks.push(chunk)
      continue
    }
    const at = chunk.text.indexOf(marker)
    const scanned = at < 0 ? chunk.text : chunk.text.slice(0, at)
    for (const ch of scanned) {
      if (ch === "\n") { row++; col = 0 } else col++
    }
    if (at < 0) {
      chunks.push(chunk)
      continue
    }
    cursor = { row, colOffset: col }
    const text = scanned + chunk.text.slice(at + marker.length)
    if (text.length) chunks.push({ ...chunk, text })
  }
  return cursor ? { text: { chunks }, cursor } : null
}
