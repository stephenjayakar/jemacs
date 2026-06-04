import type { BufferModel } from "./buffer"
import type { TextSpan } from "../modes/mode"

export type IsearchState = {
  bufferId: string
  string: string
  direction: 1 | -1
  startPoint: number
}

export function isearchMatchSpan(buffer: BufferModel, state: IsearchState): TextSpan | null {
  if (!state.string || buffer.id !== state.bufferId) return null
  const start = buffer.point
  const end = start + state.string.length
  if (buffer.text.slice(start, end) !== state.string) return null
  return { start, end, face: "isearch" }
}

export function isearchPrompt(state: IsearchState): string {
  const label = state.direction === 1 ? "I-search" : "I-search backward"
  return state.string ? `${label}: ${state.string}` : `${label}: `
}

export function findForward(text: string, needle: string, from: number): number | null {
  if (!needle) return null
  const idx = text.indexOf(needle, from)
  return idx >= 0 ? idx : null
}

export function findBackward(text: string, needle: string, before: number): number | null {
  if (!needle) return null
  const idx = text.lastIndexOf(needle, Math.max(0, before - 1))
  return idx >= 0 ? idx : null
}
