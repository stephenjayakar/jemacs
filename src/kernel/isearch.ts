import type { BufferModel } from "./buffer"

export type IsearchState = {
  bufferId: string
  string: string
  direction: 1 | -1
  startPoint: number
  regexp?: boolean
}

export type IsearchMatch = { start: number; end: number }

/** Structural subset of the display-layer TextSpan; kernel stays independent of modes/. */
export type IsearchSpan = { start: number; end: number; face: "isearch" | "lazyHighlight" }

let regexpMode = false

/** Toggle regexp interpretation for `findForward`/`findBackward` (set by isearch-*-regexp). */
export function setIsearchRegexp(on: boolean): void {
  regexpMode = on
}

/**
 * Port of Emacs `isearch-no-upper-case-p`: true when STR has no uppercase letters.
 * With REGEXP-FLAG, a letter right after a single backslash (regexp escape) is ignored,
 * and an explicit `[:upper:]`/`[:lower:]` class forces case sensitivity.
 */
export function isearchNoUpperCaseP(str: string, regexpFlag: boolean): boolean {
  let quoted = false
  for (const ch of str) {
    if (regexpFlag && ch === "\\") {
      quoted = !quoted
      continue
    }
    if (!quoted && ch !== ch.toLowerCase()) return false
    quoted = false
  }
  if (regexpFlag && /\[:(upp|low)er:]/.test(str)) return false
  return true
}

function compile(pattern: string, caseFold: boolean): RegExp | null {
  try {
    return new RegExp(pattern, caseFold ? "gi" : "g")
  } catch {
    return null
  }
}

export function findRegexpForward(text: string, pattern: string, from: number, caseFold: boolean): IsearchMatch | null {
  const re = compile(pattern, caseFold)
  if (!re) return null
  re.lastIndex = Math.max(0, from)
  const m = re.exec(text)
  return m ? { start: m.index, end: m.index + m[0].length } : null
}

export function findRegexpBackward(text: string, pattern: string, before: number, caseFold: boolean): IsearchMatch | null {
  const re = compile(pattern, caseFold)
  if (!re) return null
  let last: IsearchMatch | null = null
  for (let m = re.exec(text); m && m.index < before; m = re.exec(text)) {
    last = { start: m.index, end: m.index + m[0].length }
    if (m[0].length === 0) re.lastIndex++
  }
  return last
}

function literalIndex(text: string, needle: string, from: number, caseFold: boolean): number {
  return caseFold
    ? text.toLowerCase().indexOf(needle.toLowerCase(), from)
    : text.indexOf(needle, from)
}

function literalLastIndex(text: string, needle: string, before: number, caseFold: boolean): number {
  const at = Math.max(0, before - 1)
  return caseFold
    ? text.toLowerCase().lastIndexOf(needle.toLowerCase(), at)
    : text.lastIndexOf(needle, at)
}

export function findForward(text: string, needle: string, from: number, regexp = regexpMode): number | null {
  if (!needle) return null
  const caseFold = isearchNoUpperCaseP(needle, regexp)
  if (regexp) return findRegexpForward(text, needle, from, caseFold)?.start ?? null
  const idx = literalIndex(text, needle, from, caseFold)
  return idx >= 0 ? idx : null
}

export function findBackward(text: string, needle: string, before: number, regexp = regexpMode): number | null {
  if (!needle) return null
  const caseFold = isearchNoUpperCaseP(needle, regexp)
  if (regexp) return findRegexpBackward(text, needle, before, caseFold)?.start ?? null
  const idx = literalLastIndex(text, needle, before, caseFold)
  return idx >= 0 ? idx : null
}

export function isearchMatchSpan(buffer: BufferModel, state: IsearchState): IsearchSpan | null {
  if (!state.string || buffer.id !== state.bufferId) return null
  const start = buffer.point
  const caseFold = isearchNoUpperCaseP(state.string, state.regexp ?? false)
  if (state.regexp) {
    const m = findRegexpForward(buffer.text, state.string, start, caseFold)
    if (!m || m.start !== start) return null
    return { start, end: m.end, face: "isearch" }
  }
  const end = start + state.string.length
  const slice = buffer.text.slice(start, end)
  const a = caseFold ? slice.toLowerCase() : slice
  const b = caseFold ? state.string.toLowerCase() : state.string
  if (a !== b) return null
  return { start, end, face: "isearch" }
}

/**
 * Every match of `state.string` in `buffer` other than the one at point — Emacs paints
 * these with `lazy-highlight` while the current match keeps the `isearch` face.
 */
/** Lazy-highlight spans within [lo, hi) only — caller passes the visible range. */
export function isearchLazyHighlightSpans(
  buffer: BufferModel,
  state: IsearchState,
  lo = 0,
  hi = buffer.text.length,
  cap = 200,
): IsearchSpan[] {
  if (!state.string || buffer.id !== state.bufferId) return []
  const caseFold = isearchNoUpperCaseP(state.string, state.regexp ?? false)
  const haystack = caseFold && !state.regexp ? buffer.text.slice(lo, hi).toLowerCase() : buffer.text.slice(lo, hi)
  const needle = caseFold && !state.regexp ? state.string.toLowerCase() : state.string
  const spans: IsearchSpan[] = []
  let from = 0
  while (spans.length < cap) {
    let m: IsearchMatch | null
    if (state.regexp) {
      m = findRegexpForward(haystack, needle, from, caseFold)
    } else {
      const i = haystack.indexOf(needle, from)
      m = i >= 0 ? { start: i, end: i + needle.length } : null
    }
    if (!m) break
    const start = lo + m.start
    if (start !== buffer.point) spans.push({ start, end: lo + m.end, face: "lazyHighlight" })
    from = Math.max(m.end, m.start + 1)
  }
  return spans
}

export function isearchPrompt(state: IsearchState): string {
  const kind = state.regexp ? "Regexp I-search" : "I-search"
  const label = state.direction === 1 ? kind : `${kind} backward`
  return state.string ? `${label}: ${state.string}` : `${label}: `
}
