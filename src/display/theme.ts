import type { FaceName, TextSpan } from "../modes/mode"
import { createTextAttributes, parseColor, StyledText, type TextChunk } from "@opentui/core"

export type FaceStyle = {
  fg?: string
  bg?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
}

export type Theme = {
  name: string
  faces: Partial<Record<FaceName, FaceStyle>>
}

export const defaultTheme: Theme = {
  name: "jemacs-dark",
  faces: {
    default: { fg: "#d4d4d4" },
    keyword: { fg: "#569cd6", bold: true },
    string: { fg: "#ce9178" },
    comment: { fg: "#6a9955", italic: true },
    builtin: { fg: "#4ec9b0" },
    function: { fg: "#dcdcaa" },
    type: { fg: "#4ec9b0" },
    number: { fg: "#b5cea8" },
    constant: { fg: "#9cdcfe" },
    directory: { fg: "#4fc1ff", bold: true },
    region: { bg: "#3f4756" },
    modeLine: { fg: "#ffffff", bg: "#264f78", bold: true },
    minibuffer: { fg: "#ffffff", bg: "#3a3a3a" },
    error: { fg: "#f44747", bold: true },
  },
}

export function applyTheme(text: string, spans: TextSpan[], theme: Theme): StyledText {
  if (!spans.length) return new StyledText([plainChunk(text)])
  const ordered = spans
    .filter(span => span.end > span.start && span.start < text.length)
    .map(span => ({ ...span, start: Math.max(0, span.start), end: Math.min(text.length, span.end) }))
  const boundaries = [...new Set([0, text.length, ...ordered.flatMap(span => [span.start, span.end])])]
    .sort((a, b) => a - b)
  const chunks: TextChunk[] = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!
    const end = boundaries[i + 1]!
    if (start === end) continue
    const style = ordered.reduce<FaceStyle | undefined>((merged, span) => {
      if (span.start > start || span.end < end) return merged
      return mergeStyle(merged, theme.faces[span.face])
    }, undefined)
    chunks.push(styledChunk(text.slice(start, end), style))
  }
  return new StyledText(chunks)
}

function mergeStyle(base: FaceStyle | undefined, overlay: FaceStyle | undefined): FaceStyle | undefined {
  if (!overlay) return base
  return { ...base, ...overlay }
}

function plainChunk(text: string): TextChunk {
  return { __isChunk: true, text }
}

function styledChunk(text: string, style?: FaceStyle): TextChunk {
  if (!style) return plainChunk(text)
  return {
    __isChunk: true,
    text,
    fg: style.fg ? parseColor(style.fg) : undefined,
    bg: style.bg ? parseColor(style.bg) : undefined,
    attributes: createTextAttributes(style),
  }
}
