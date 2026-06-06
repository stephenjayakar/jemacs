import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import type { TextSpan } from "../../src/modes/mode"
import { defineMode, enterMode } from "../../src/modes/mode"
import { Keymap } from "../../src/kernel/keymap"

export const ORG_FOLDED_LOCAL = "org-folded"

// Spec: /^(\*+) (TODO|DONE)? ?(.*)/ — stars, optional keyword, headline text.
const HEADLINE_RE = /^(\*+) (TODO|DONE)? ?(.*)$/
const TODO_CYCLE = ["TODO", "DONE", null] as const

export type OrgHeadline = {
  /** 0-based line index. */
  line: number
  /** Buffer offset of the line's first char. */
  start: number
  /** Buffer offset just past the last non-newline char. */
  end: number
  level: number
  keyword: "TODO" | "DONE" | null
  title: string
}

/** 0-indexed [startLine, endLine] inclusive ranges that are hidden. */
export type FoldRange = [number, number]

export function orgParseHeadlines(text: string): OrgHeadline[] {
  const out: OrgHeadline[] = []
  let offset = 0
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = HEADLINE_RE.exec(line)
    if (m) {
      out.push({
        line: i,
        start: offset,
        end: offset + line.length,
        level: m[1]!.length,
        keyword: (m[2] as "TODO" | "DONE" | undefined) ?? null,
        title: m[3] ?? "",
      })
    }
    offset += line.length + 1
  }
  return out
}

/** Headline whose line contains `point`, or null. */
export function orgHeadlineAtPoint(text: string, point: number): OrgHeadline | null {
  const headlines = orgParseHeadlines(text)
  const before = text.slice(0, point)
  const line = before.split("\n").length - 1
  return headlines.find(h => h.line === line) ?? null
}

/** Last line index (inclusive) of `h`'s subtree — the line before the next
 *  headline at the same or higher level, else the last line of the buffer. */
export function orgSubtreeEndLine(headlines: OrgHeadline[], h: OrgHeadline, lineCount: number): number {
  for (const next of headlines) {
    if (next.line > h.line && next.level <= h.level) return next.line - 1
  }
  return lineCount - 1
}

/** Direct children of `h` (one level deeper, within its subtree). */
export function orgChildren(headlines: OrgHeadline[], h: OrgHeadline, lineCount: number): OrgHeadline[] {
  const end = orgSubtreeEndLine(headlines, h, lineCount)
  return headlines.filter(c => c.line > h.line && c.line <= end && c.level === h.level + 1)
}

function lineCount(text: string): number {
  return text.split("\n").length
}

function foldedRanges(buffer: BufferModel): FoldRange[] {
  return (buffer.locals.get(ORG_FOLDED_LOCAL) as FoldRange[] | undefined) ?? []
}

function setFolded(buffer: BufferModel, ranges: FoldRange[]): void {
  // Normalize: sort, drop empties, merge overlaps so state inference is stable.
  const sorted = ranges.filter(([a, b]) => a <= b).sort((x, y) => x[0] - y[0])
  const merged: FoldRange[] = []
  for (const r of sorted) {
    const last = merged.at(-1)
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  buffer.locals.set(ORG_FOLDED_LOCAL, merged)
}

/** Hidden character ranges derived from the folded line ranges, for the
 *  display layer. Each range starts at the newline ending the preceding
 *  visible line so an ellipsis can render there. */
export function orgVisibleSpans(buffer: BufferModel): Array<{ start: number; end: number }> {
  const ranges = foldedRanges(buffer)
  if (!ranges.length) return []
  const lines = buffer.text.split("\n")
  const offsets: number[] = [0]
  for (const l of lines) offsets.push(offsets.at(-1)! + l.length + 1)
  const out: Array<{ start: number; end: number }> = []
  for (const [a, b] of ranges) {
    if (a < 0 || a >= lines.length) continue
    const bb = Math.min(b, lines.length - 1)
    const start = Math.max(0, offsets[a]! - 1) // include preceding newline
    const end = offsets[bb]! + lines[bb]!.length
    if (start < end) out.push({ start, end })
  }
  return out
}

type DisplayFilterResult = { text: string; map: (n: number) => number }
type DisplayFilterCache = { text: string; ranges: FoldRange[]; result: DisplayFilterResult }
const ORG_FILTER_CACHE = "org--display-filter-cache"

/** Mode `displayFilter`: collapse folded line ranges, append `...` to the
 *  preceding visible line, and remap buffer offsets onto the shorter text.
 *  Hidden offsets clamp to the end of the preceding visible line so spans
 *  there become zero-width and the cursor lands on the ellipsis.
 *
 *  Called every render; the rebuild is O(n) and `map` is invoked twice per
 *  font-lock span, so the result is memoized in buffer.locals keyed on
 *  (text, fold-ranges) identity — both change exactly when `_splice` or
 *  `setFolded` runs. */
export function orgDisplayFilter(buffer: BufferModel): DisplayFilterResult | null {
  const ranges = foldedRanges(buffer)
  if (!ranges.length) return null
  const src = buffer.text
  const cached = buffer.locals.get(ORG_FILTER_CACHE) as DisplayFilterCache | undefined
  if (cached && cached.text === src && cached.ranges === ranges) return cached.result

  const lines = src.split("\n")
  const L = lines.length
  const lineHidden = new Uint8Array(L)
  for (const [a, b] of ranges)
    for (let i = Math.max(0, a); i <= b && i < L; i++) lineHidden[i] = 1

  const bufStart: number[] = new Array(L)
  const lineLen: number[] = new Array(L)
  for (let o = 0, i = 0; i < L; i++) { bufStart[i] = o; lineLen[i] = lines[i]!.length; o += lineLen[i]! + 1 }

  const dispStart: number[] = new Array(L)
  const parts: string[] = []
  let dispLen = 0
  let lastVisibleEnd = 0
  for (let i = 0; i < L; i++) {
    if (lineHidden[i]) { dispStart[i] = lastVisibleEnd; continue }
    if (dispLen > 0) { parts.push("\n"); dispLen += 1 }
    dispStart[i] = dispLen
    parts.push(lines[i]!)
    dispLen += lineLen[i]!
    lastVisibleEnd = dispLen
    if (i + 1 < L && lineHidden[i + 1]) { parts.push("..."); dispLen += 3 }
  }
  const text = parts.join("")

  const map = (n: number): number => {
    const nn = Math.max(0, Math.min(n, src.length))
    // upper_bound(bufStart, nn) - 1 → line containing nn.
    let lo = 0, hi = L
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (bufStart[mid]! <= nn) lo = mid + 1; else hi = mid
    }
    const i = lo - 1
    if (lineHidden[i]) return dispStart[i]!
    return dispStart[i]! + Math.min(nn - bufStart[i]!, lineLen[i]!)
  }
  const result = { text, map }
  buffer.locals.set(ORG_FILTER_CACHE, { text: src, ranges, result } satisfies DisplayFilterCache)
  return result
}

type CycleState = "folded" | "children" | "subtree"

function inferState(folded: FoldRange[], h: OrgHeadline, subEnd: number): CycleState {
  if (h.line >= subEnd) return "subtree" // empty subtree — nothing to fold
  const covers = (a: number, b: number) => folded.some(([x, y]) => x <= a && b <= y)
  if (covers(h.line + 1, subEnd)) return "folded"
  const any = folded.some(([x, y]) => x >= h.line + 1 && y <= subEnd)
  return any ? "children" : "subtree"
}

function cycle(buffer: BufferModel): CycleState | null {
  const text = buffer.text
  const headlines = orgParseHeadlines(text)
  const h = orgHeadlineAtPoint(text, buffer.point)
  if (!h) return null
  const lc = lineCount(text)
  const subEnd = orgSubtreeEndLine(headlines, h, lc)
  if (subEnd <= h.line) return "subtree"
  const outside = foldedRanges(buffer).filter(([a, b]) => b < h.line + 1 || a > subEnd)
  const state = inferState(foldedRanges(buffer), h, subEnd)
  let next: CycleState
  if (state === "folded") {
    next = "children"
    for (const child of orgChildren(headlines, h, lc)) {
      const childEnd = orgSubtreeEndLine(headlines, child, lc)
      if (childEnd > child.line) outside.push([child.line + 1, childEnd])
    }
  } else if (state === "children") {
    next = "subtree" // `outside` already has the subtree's ranges stripped.
  } else {
    next = "folded"
    outside.push([h.line + 1, subEnd])
  }
  setFolded(buffer, outside)
  return next
}

function todoCycle(buffer: BufferModel): void {
  const h = orgHeadlineAtPoint(buffer.text, buffer.point)
  if (!h) return
  const next = TODO_CYCLE[(TODO_CYCLE.indexOf(h.keyword) + 1) % TODO_CYCLE.length]
  const stars = "*".repeat(h.level)
  const replacement = next ? `${stars} ${next} ${h.title}` : `${stars} ${h.title}`
  buffer.replaceRange(h.start, h.end, replacement)
  buffer.point = h.start
}

function insertSibling(buffer: BufferModel): void {
  const text = buffer.text
  const headlines = orgParseHeadlines(text)
  const before = text.slice(0, buffer.point)
  const line = before.split("\n").length - 1
  // Nearest headline at or above point determines the sibling level.
  const ref = [...headlines].reverse().find(h => h.line <= line)
  const level = ref?.level ?? 1
  const lc = lineCount(text)
  const insertLine = ref ? orgSubtreeEndLine(headlines, ref, lc) + 1 : lc
  const lines = text.split("\n")
  let offset = 0
  for (let i = 0; i < insertLine; i++) offset += lines[i]!.length + 1
  offset = Math.min(offset, text.length)
  const needsNl = offset > 0 && text[offset - 1] !== "\n"
  const heading = `${"*".repeat(level)} `
  buffer.replaceRange(offset, offset, (needsNl ? "\n" : "") + heading + "\n")
  buffer.point = offset + (needsNl ? 1 : 0) + heading.length
}

function shiftLevel(buffer: BufferModel, delta: 1 | -1): void {
  const h = orgHeadlineAtPoint(buffer.text, buffer.point)
  if (!h) return
  const level = Math.max(1, h.level + delta)
  if (level === h.level) return
  buffer.replaceRange(h.start, h.start + h.level, "*".repeat(level))
  buffer.point = h.start
}

function gotoHeading(buffer: BufferModel, dir: 1 | -1): boolean {
  const headlines = orgParseHeadlines(buffer.text)
  const target = dir === 1
    ? headlines.find(h => h.start > buffer.point)
    : [...headlines].reverse().find(h => h.start < buffer.point)
  if (!target) return false
  buffer.point = target.start
  return true
}

export function orgFontLock(buffer: BufferModel): TextSpan[] {
  const spans: TextSpan[] = []
  for (const h of orgParseHeadlines(buffer.text)) {
    const starsEnd = h.start + h.level
    spans.push({ start: h.start, end: starsEnd, face: "comment" })
    let titleStart = starsEnd + 1
    if (h.keyword) {
      const kwStart = starsEnd + 1
      const kwEnd = kwStart + h.keyword.length
      // `error` is underline-only in both shipped themes; use `keyword` so TODO pops (t-7cff330a).
      spans.push({ start: kwStart, end: kwEnd, face: h.keyword === "TODO" ? "keyword" : "string" })
      titleStart = kwEnd + 1
    }
    if (titleStart < h.end) spans.push({ start: titleStart, end: h.end, face: "function" })
  }
  return spans
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const keymap = new Keymap("org-mode-map")
  keymap.bind("tab", "org-cycle")
  keymap.bind("C-c C-t", "org-todo")
  keymap.bind("M-RET", "org-meta-return")
  keymap.bind("M-left", "org-promote")
  keymap.bind("M-right", "org-demote")
  keymap.bind("C-c C-n", "org-next-heading")
  keymap.bind("C-c C-p", "org-previous-heading")

  defineMode({
    name: "org-mode",
    parent: "text",
    commentStart: "#",
    keymap,
    fontLock: orgFontLock,
    displayFilter: orgDisplayFilter,
  })

  editor.command("org-cycle", ({ editor, buffer }) => {
    const state = cycle(buffer)
    if (state == null) editor.message("Not at a heading")
    else editor.message(state.toUpperCase())
  }, "TAB on a headline: cycle visibility folded → children → subtree.")

  editor.command("org-todo", ({ buffer }) => todoCycle(buffer),
    "Cycle the TODO keyword of the current heading: TODO → DONE → (none).")

  editor.command("org-meta-return", ({ buffer }) => insertSibling(buffer),
    "Insert a new sibling heading after the current subtree.")

  editor.command("org-promote", ({ buffer }) => shiftLevel(buffer, -1),
    "Decrease the level of the current heading by one.")
  editor.command("org-demote", ({ buffer }) => shiftLevel(buffer, +1),
    "Increase the level of the current heading by one.")

  editor.command("org-next-heading", ({ editor, buffer }) => {
    if (!gotoHeading(buffer, 1)) editor.message("No next heading")
  }, "Move to the next heading.")
  editor.command("org-previous-heading", ({ editor, buffer }) => {
    if (!gotoHeading(buffer, -1)) editor.message("No previous heading")
  }, "Move to the previous heading.")

  editor.command("org-mode", ({ editor, buffer }) => editor.enterMode(buffer, "org-mode"),
    "Major mode for editing Org files.")

  // inferMode() doesn't know .org; pick it up at find-file time instead.
  ctx.hook("find-file-hook", ({ buffer }) => {
    if (buffer.path && /\.org$/i.test(buffer.path)) enterMode(buffer, "org-mode")
  })
}
