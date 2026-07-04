import { BufferModel, inferMode } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { addHook } from "../../src/kernel/hooks"
import { Keymap } from "../../src/kernel/keymap"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { defface, faceRemapAddRelative, FIXED_PITCH_FAMILY, VARIABLE_PITCH_FAMILY } from "../../src/runtime/faces"
import { defineMode, enterMode, getMode, modeFeature, type FaceName, type FontLockRange, type TextSpan } from "../../src/modes/mode"
import { registeredTreeSitterLanguages, treeSitterFontLock } from "../../src/modes/tree-sitter"
import { registerTreeSitterGrammars } from "../tree-sitter-grammars"

const TAB_WIDTH = 4
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+/
const ORDERED_LIST_RE = /^(\s*)(\d+)([.)])\s+/
const ATX_HEADER_RE = /^(#{1,6})\s/
const BLOCKQUOTE_RE = /^(\s*)>+\s?/
const FENCED_CODE_RE = /^(`{3,}|~{3,})/
const FENCE_LINE_RE = /^(\s*)(`{3,}|~{3,})(\S*)(\s*)$/
const SETEXT_UNDERLINE_RE = /^(\s*)(=+|-+)\s*$/

export const MARKDOWN_FOLDED_LOCAL = "markdown-folded"
export const MARKDOWN_SUBTREE_STATUS = "markdown-cycle-subtree-status"
export const MARKDOWN_GLOBAL_STATUS = "markdown-cycle-global-status"
const MARKDOWN_FILTER_CACHE = "markdown--display-filter-cache"
const MARKDOWN_LAST_INDENT = "markdown-last-indent-command"
const MARKDOWN_FILL_COLUMN = "markdown-fill-column"
const MARKDOWN_VISUAL_FILL = "markdown-visual-fill-column-mode"

defcustom("markdown-fill-column", "number", 100, "Soft-wrap width for markdown buffers (Stephen's Notion-style layout).")
defcustom("markdown-visual-fill-column-center-text", "boolean", true, "Center body text within the fill column.")
defcustom("markdown-fontify-code-blocks-natively", "boolean", false, "Fontify fenced code blocks using the language major mode.")
defcustom("markdown-fontify-code-block-default-mode", "string", "", "Default mode for fenced blocks with no language (empty = none).")
defcustom("markdown-code-lang-modes", "sexp", [
  ["cpp", "c"],
  ["C", "c"],
  ["C++", "c"],
  ["shell", "text"],
  ["bash", "text"],
  ["sh", "text"],
  ["elisp", "text"],
], "Alist mapping fence info strings to jemacs major modes.")
defcustom("markdown-display-inline-images", "boolean", true, "Replace image links with inline placeholders in the display layer.")
defcustom("markdown-display-remote-images", "boolean", true, "Allow remote image URLs in inline image display.")
defcustom("markdown-hide-markup", "boolean", false, "Hide markup delimiters in the display layer (WYSIWYG-style editing).")
defcustom("markdown-hide-urls", "boolean", false, "Compose link URLs to a single glyph when markup hiding is active.")
defcustom("markdown-hide-markup-in-view-modes", "boolean", true, "Enable hidden markup in markdown-view-mode and gfm-view-mode.")
defcustom("word-wrap", "boolean", false, "Wrap display lines at word boundaries when soft wrapping.")

const MARKDOWN_HIDE_MARKUP = "markdown-hide-markup"
const MARKDOWN_HIDE_URLS = "markdown-hide-urls"
const MARKDOWN_FONTIFY_CODE_BLOCKS = "markdown-fontify-code-blocks-natively"
const LIST_BULLET = "•"
const URL_COMPOSE_CHAR = "↪"

const MARKDOWN_HEADER_FACES = [
  ["markdown-header-face-1", 2.0],
  ["markdown-header-face-2", 1.7],
  ["markdown-header-face-3", 1.4],
  ["markdown-header-face-4", 1.2],
  ["markdown-header-face-5", 1.1],
  ["markdown-header-face-6", 1.0],
] as const

export type MarkdownHeading = {
  line: number
  start: number
  end: number
  level: number
  title: string
}

export type FencedCodeBlock = {
  openLine: number
  closeLine: number
  bodyStart: number
  bodyEnd: number
  lang: string | null
  fence: string
}

export type FoldRange = [number, number]
const EMPTY_FOLD_RANGES: FoldRange[] = []
type SubtreeCycle = "folded" | "children" | "subtree"
type GlobalCycle = 1 | 2 | 3
type DisplayFilterResult = { text: string; map: (n: number) => number; unmap?: (n: number) => number }
type MarkupOp = { start: number; end: number; display: string }
type LineRenderMap = {
  text: string
  bufToDisp: number[]
  dispToBuf: number[]
}
type DisplayLineMap = {
  line: number
  dispStart: number
  displayLen: number
  bufToDisp?: number[]
  dispToBuf?: number[]
}
type DisplayFilterCache = {
  text: string
  ranges: FoldRange[]
  hideMarkup: boolean
  hideUrls: boolean
  result: DisplayFilterResult
}

function markdownHideMarkup(buffer: BufferModel): boolean {
  const local = buffer.locals.get(MARKDOWN_HIDE_MARKUP)
  if (typeof local === "boolean") return local
  return getCustom<boolean>("markdown-hide-markup") ?? false
}

function markdownHideUrls(buffer: BufferModel): boolean {
  const local = buffer.locals.get(MARKDOWN_HIDE_URLS)
  if (typeof local === "boolean") return local
  return getCustom<boolean>("markdown-hide-urls") ?? false
}

function setMarkdownHideMarkup(buffer: BufferModel, value: boolean): void {
  buffer.locals.set(MARKDOWN_HIDE_MARKUP, value)
  buffer.locals.delete(MARKDOWN_FILTER_CACHE)
}

function setMarkdownHideUrls(buffer: BufferModel, value: boolean): void {
  buffer.locals.set(MARKDOWN_HIDE_URLS, value)
  buffer.locals.delete(MARKDOWN_FILTER_CACHE)
}

function markdownFontifyCodeBlocksNatively(buffer: BufferModel): boolean {
  const local = buffer.locals.get(MARKDOWN_FONTIFY_CODE_BLOCKS)
  if (typeof local === "boolean") return local
  return getCustom<boolean>("markdown-fontify-code-blocks-natively") ?? false
}

function setMarkdownFontifyCodeBlocksNatively(buffer: BufferModel, value: boolean): void {
  buffer.locals.set(MARKDOWN_FONTIFY_CODE_BLOCKS, value)
}

export function parseFencedCodeBlocks(text: string): FencedCodeBlock[] {
  const lines = text.split("\n")
  const blocks: FencedCodeBlock[] = []
  let offset = 0
  let open: { line: number; fence: string; lang: string | null; charEnd: number } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineStart = offset
    const lineEnd = lineStart + line.length
    const m = line.match(FENCE_LINE_RE)
    if (m?.[2]) {
      const fence = m[2]
      if (!open) {
        open = { line: i, fence, lang: m[3] || null, charEnd: lineEnd }
      } else if (fence === open.fence && !m[3]) {
        blocks.push({
          openLine: open.line,
          closeLine: i,
          bodyStart: open.charEnd + 1,
          bodyEnd: lineStart,
          lang: open.lang,
          fence: open.fence,
        })
        open = null
      }
    }
    offset = lineEnd + 1
  }
  return blocks
}

function markdownGetLangMode(lang: string | null): string | null {
  const fallbackRaw = getCustom<string>("markdown-fontify-code-block-default-mode") ?? ""
  const fallback = fallbackRaw && getMode(fallbackRaw) ? fallbackRaw : null
  if (!lang?.trim()) return fallback
  const normalized = lang.trim()
  const alist = getCustom<Array<[string, string]>>("markdown-code-lang-modes") ?? []
  for (const [key, mode] of alist) {
    if ((key === normalized || key.toLowerCase() === normalized.toLowerCase()) && getMode(mode)) return mode
  }
  const candidates = [
    inferMode(`block.${normalized}`),
    inferMode(`block.${normalized}.txt`),
    normalized,
    normalized.toLowerCase(),
  ]
  for (const mode of candidates) {
    if (mode !== "text" && modeFeature(mode, "fontLock")) return mode
  }
  if (registeredTreeSitterLanguages().includes(normalized)) return normalized
  const lower = normalized.toLowerCase()
  if (registeredTreeSitterLanguages().includes(lower)) return lower
  return fallback
}

function spanInsideRegions(start: number, end: number, regions: ReadonlyArray<readonly [number, number]>): boolean {
  return regions.some(([a, b]) => start >= a && end <= b)
}

function markdownFontifyCodeBlockNatively(lang: string | null, body: string): TextSpan[] {
  const mode = markdownGetLangMode(lang)
  if (!mode || !body) return [{ start: 0, end: body.length, face: "string" }]
  const scratch = new BufferModel({ name: "markdown-code-fontification", text: body, mode })
  const fontLock = modeFeature(mode, "fontLock")
  if (!fontLock) return [{ start: 0, end: body.length, face: "string" }]
  return fontLock(scratch)
}

function toggleBufferBoolean(
  buffer: BufferModel,
  current: () => boolean,
  set: (buffer: BufferModel, value: boolean) => void,
  prefixArgument: number | null | undefined,
): boolean {
  const next = prefixArgument == null
    ? !current()
    : prefixArgument > 0
  set(buffer, next)
  return next
}

export function markdownParseHeadings(text: string): MarkdownHeading[] {
  const lines = text.split("\n")
  const out: MarkdownHeading[] = []
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const atx = line.match(/^(\s*)(#{1,6})\s+(.*)$/)
    if (atx) {
      out.push({
        line: i,
        start: offset,
        end: offset + line.length,
        level: atx[2]!.length,
        title: atx[3] ?? "",
      })
    } else if (i + 1 < lines.length && line.trim()) {
      const next = lines[i + 1]!
      const setext = SETEXT_UNDERLINE_RE.exec(next)
      if (setext && !line.match(/^#{1,6}\s/)) {
        const level = setext[2]!.startsWith("=") ? 1 : 2
        out.push({ line: i, start: offset, end: offset + line.length, level, title: line.trim() })
      }
    }
    offset += line.length + 1
  }
  return out
}

export function markdownHeadingAtPoint(text: string, point: number): MarkdownHeading | null {
  const line = text.slice(0, point).split("\n").length - 1
  return markdownParseHeadings(text).find(h => h.line === line) ?? null
}

export function markdownSubtreeEndLine(headings: MarkdownHeading[], h: MarkdownHeading, lineCount: number): number {
  for (const next of headings) {
    if (next.line > h.line && next.level <= h.level) return next.line - 1
  }
  return lineCount - 1
}

function markdownChildren(headings: MarkdownHeading[], h: MarkdownHeading, lineCount: number): MarkdownHeading[] {
  const end = markdownSubtreeEndLine(headings, h, lineCount)
  return headings.filter(c => c.line > h.line && c.line <= end && c.level === h.level + 1)
}

function foldedRanges(buffer: BufferModel): FoldRange[] {
  return (buffer.locals.get(MARKDOWN_FOLDED_LOCAL) as FoldRange[] | undefined) ?? EMPTY_FOLD_RANGES
}

function subtreeStatusMap(buffer: BufferModel): Map<number, SubtreeCycle> {
  const existing = buffer.locals.get(MARKDOWN_SUBTREE_STATUS) as Map<number, SubtreeCycle> | undefined
  if (existing) return existing
  const map = new Map<number, SubtreeCycle>()
  buffer.locals.set(MARKDOWN_SUBTREE_STATUS, map)
  return map
}

function globalStatus(buffer: BufferModel): GlobalCycle {
  return (buffer.locals.get(MARKDOWN_GLOBAL_STATUS) as GlobalCycle | undefined) ?? 1
}

function setGlobalStatus(buffer: BufferModel, status: GlobalCycle): void {
  buffer.locals.set(MARKDOWN_GLOBAL_STATUS, status)
}

function mergeFoldRanges(ranges: FoldRange[]): FoldRange[] {
  const sorted = ranges.filter(([a, b]) => a <= b).sort((x, y) => x[0] - y[0])
  const merged: FoldRange[] = []
  for (const r of sorted) {
    const last = merged.at(-1)
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}

function setFolded(buffer: BufferModel, ranges: FoldRange[]): void {
  buffer.locals.set(MARKDOWN_FOLDED_LOCAL, mergeFoldRanges(ranges))
  buffer.locals.delete(MARKDOWN_FILTER_CACHE)
}

function hideSublevels(headings: MarkdownHeading[], maxLevel: number, lineCount: number): FoldRange[] {
  const ranges: FoldRange[] = []
  for (const h of headings) {
    if (h.level <= maxLevel) continue
    const end = markdownSubtreeEndLine(headings, h, lineCount)
    if (end > h.line) ranges.push([h.line + 1, end])
  }
  return ranges
}

function recomputeFoldRanges(buffer: BufferModel): FoldRange[] {
  const text = buffer.text
  const headings = markdownParseHeadings(text)
  const lines = text.split("\n")
  const lineCount = lines.length
  const headingLines = new Set(headings.map(h => h.line))
  const setextUnderlines = new Set<number>()
  for (let i = 0; i < lines.length - 1; i++) {
    if (SETEXT_UNDERLINE_RE.test(lines[i + 1]!) && lines[i]!.trim()) setextUnderlines.add(i + 1)
  }

  const ranges: FoldRange[] = []
  const g = globalStatus(buffer)
  if (g === 2) {
    for (let i = 0; i < lineCount; i++) {
      if (!headingLines.has(i) && !setextUnderlines.has(i)) ranges.push([i, i])
    }
  } else if (g === 3) {
    ranges.push(...hideSublevels(headings, 1, lineCount))
  }

  const status = subtreeStatusMap(buffer)
  for (const [line, cycle] of status) {
    const h = headings.find(x => x.line === line)
    if (!h) continue
    const end = markdownSubtreeEndLine(headings, h, lineCount)
    if (cycle === "folded") {
      if (end > h.line) ranges.push([h.line + 1, end])
    } else if (cycle === "children") {
      for (const child of markdownChildren(headings, h, lineCount)) {
        const childEnd = markdownSubtreeEndLine(headings, child, lineCount)
        if (childEnd > child.line) ranges.push([child.line + 1, childEnd])
      }
    }
  }
  return mergeFoldRanges(ranges)
}

function syncFoldRanges(buffer: BufferModel): void {
  setFolded(buffer, recomputeFoldRanges(buffer))
}

function mergeMarkupOps(ops: MarkupOp[]): MarkupOp[] {
  if (!ops.length) return []
  const sorted = [...ops].sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: MarkupOp[] = []
  for (const op of sorted) {
    const last = merged.at(-1)
    if (!last || op.start >= last.end) merged.push({ ...op })
    else if (op.end > last.end) last.end = op.end
  }
  return merged
}

function protectedInlineCodeRanges(line: string, lineStart: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    if (m.index == null) continue
    const innerStart = lineStart + m.index + 1
    out.push([innerStart, innerStart + m[1]!.length])
  }
  return out
}

function rangeProtected(start: number, end: number, protectedRanges: Array<[number, number]>): boolean {
  return protectedRanges.some(([a, b]) => start >= a && end <= b)
}

function pushMarkupHide(
  ops: MarkupOp[],
  start: number,
  end: number,
  protectedRanges: Array<[number, number]>,
  display = "",
): void {
  if (start >= end || rangeProtected(start, end, protectedRanges)) return
  ops.push({ start, end, display })
}

function collectInlineMarkupHides(
  line: string,
  lineStart: number,
  hideUrls: boolean,
  protectedRanges: Array<[number, number]>,
  ops: MarkupOp[],
): void {
  for (const m of line.matchAll(/!?\[([^\]]*)\]\(([^)]*)\)/g)) {
    if (m.index == null) continue
    const i = m.index
    const textEnd = i + 1 + (m[1]?.length ?? 0)
    const urlStart = textEnd + 2
    const urlEnd = urlStart + (m[2]?.length ?? 0)
    pushMarkupHide(ops, lineStart + i, lineStart + i + 1, protectedRanges)
    pushMarkupHide(ops, lineStart + textEnd, lineStart + urlStart, protectedRanges)
    if (hideUrls && m[2]) {
      pushMarkupHide(ops, lineStart + urlStart, lineStart + urlEnd, protectedRanges, URL_COMPOSE_CHAR)
    }
    pushMarkupHide(ops, lineStart + urlEnd, lineStart + urlEnd + 1, protectedRanges)
  }
  for (const m of line.matchAll(/<((?:https?:\/\/|mailto:)[^>]+)>/g)) {
    if (m.index == null) continue
    pushMarkupHide(ops, lineStart + m.index, lineStart + m.index + 1, protectedRanges)
    if (hideUrls) {
      pushMarkupHide(ops, lineStart + m.index + 1, lineStart + m.index + 1 + m[1]!.length, protectedRanges, URL_COMPOSE_CHAR)
    }
    pushMarkupHide(ops, lineStart + m.index + m[0].length - 1, lineStart + m.index + m[0].length, protectedRanges)
  }
  for (const m of line.matchAll(/\*\*(\S(?:.*?\S)?)\*\*/g)) {
    if (m.index == null) continue
    pushMarkupHide(ops, lineStart + m.index, lineStart + m.index + 2, protectedRanges)
    pushMarkupHide(ops, lineStart + m.index + m[0].length - 2, lineStart + m.index + m[0].length, protectedRanges)
  }
  for (const m of line.matchAll(/__(\S(?:.*?\S)?)__/g)) {
    if (m.index == null) continue
    pushMarkupHide(ops, lineStart + m.index, lineStart + m.index + 2, protectedRanges)
    pushMarkupHide(ops, lineStart + m.index + m[0].length - 2, lineStart + m.index + m[0].length, protectedRanges)
  }
  for (const m of line.matchAll(/~~(\S(?:.*?\S)?)~~/g)) {
    if (m.index == null) continue
    pushMarkupHide(ops, lineStart + m.index, lineStart + m.index + 2, protectedRanges)
    pushMarkupHide(ops, lineStart + m.index + m[0].length - 2, lineStart + m.index + m[0].length, protectedRanges)
  }
  for (const m of line.matchAll(/(?<!\*)\*(?!\*)(\S(?:.*?\S)?)\*(?!\*)/g)) {
    if (m.index == null) continue
    pushMarkupHide(ops, lineStart + m.index, lineStart + m.index + 1, protectedRanges)
    pushMarkupHide(ops, lineStart + m.index + m[0].length - 1, lineStart + m.index + m[0].length, protectedRanges)
  }
  for (const m of line.matchAll(/(?<!_)_(?!_)(\S(?:.*?\S)?)_(?!_)/g)) {
    if (m.index == null) continue
    pushMarkupHide(ops, lineStart + m.index, lineStart + m.index + 1, protectedRanges)
    pushMarkupHide(ops, lineStart + m.index + m[0].length - 1, lineStart + m.index + m[0].length, protectedRanges)
  }
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    if (m.index == null) continue
    pushMarkupHide(ops, lineStart + m.index, lineStart + m.index + 1, protectedRanges)
    pushMarkupHide(ops, lineStart + m.index + m[0].length - 1, lineStart + m.index + m[0].length, protectedRanges)
  }
}

function collectMarkupHides(text: string, hideUrls: boolean): MarkupOp[] {
  const ops: MarkupOp[] = []
  const lines = text.split("\n")
  const blocks = parseFencedCodeBlocks(text)
  const codeBodyRanges: Array<[number, number]> = []
  const lineStarts: number[] = []
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    lineStarts[i] = offset
    offset += lines[i]!.length + 1
  }
  for (const block of blocks) {
    if (block.bodyEnd > block.bodyStart) codeBodyRanges.push([block.bodyStart, block.bodyEnd])
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!
    const lineStart = lineStarts[lineIdx]!
    const lineEnd = lineStart + line.length
    if (codeBodyRanges.some(([a, b]) => lineStart >= a && lineEnd <= b)) continue

    const atx = line.match(/^(\s*)(#{1,6})(\s+)(.*?)(\s+#+\s*)?$/)
    if (atx) {
      const markerStart = lineStart + atx[1]!.length
      const titleStart = markerStart + atx[2]!.length + atx[3]!.length
      pushMarkupHide(ops, markerStart, titleStart, [])
      if (atx[5]) {
        const closeStart = lineEnd - atx[5].length
        pushMarkupHide(ops, closeStart, lineEnd, [])
      }
    } else if (SETEXT_UNDERLINE_RE.test(line) && lineIdx > 0 && lines[lineIdx - 1]!.trim()) {
      pushMarkupHide(ops, lineStart, lineEnd, [])
    }

    const bq = line.match(/^(\s*)(>+\s?)/)
    if (bq) {
      const markerStart = lineStart + bq[1]!.length
      pushMarkupHide(ops, markerStart, markerStart + bq[2]!.length, [], "")
    }

    const list = line.match(/^(\s*)([-*+]|\d+[.)])\s+/)
    if (list) {
      const markerStart = lineStart + list[1]!.length
      const markerEnd = lineStart + list[0]!.length
      const bullet = /^\d/.test(list[2]!) ? `${list[2]} ` : `${LIST_BULLET} `
      pushMarkupHide(ops, markerStart, markerEnd, [], bullet)
    }

    if (/^(\s*)([-*_])\1{2,}\s*$/.test(line)) {
      const hr = "─".repeat(Math.max(3, line.trim().length))
      pushMarkupHide(ops, lineStart, lineEnd, [], hr)
    }

    const protectedRanges = protectedInlineCodeRanges(line, lineStart)
    collectInlineMarkupHides(line, lineStart, hideUrls, protectedRanges, ops)
  }
  return mergeMarkupOps(ops)
}

function renderLineWithMarkupMap(line: string, lineStart: number, ops: MarkupOp[]): LineRenderMap {
  const out: string[] = []
  const bufToDisp = new Array<number>(line.length + 1)
  const dispToBuf: number[] = []
  let opIdx = 0
  let col = 0
  let disp = 0
  while (col < line.length) {
    while (opIdx < ops.length && ops[opIdx]!.end <= lineStart + col) opIdx++
    const op = ops[opIdx]
    if (op && op.start === lineStart + col) {
      const endCol = Math.min(line.length, op.end - lineStart)
      for (let c = col; c < endCol; c++) bufToDisp[c] = disp
      for (let i = 0; i < op.display.length; i++) {
        out.push(op.display[i]!)
        dispToBuf[disp++] = col
      }
      col = endCol
      continue
    }
    bufToDisp[col] = disp
    out.push(line[col]!)
    dispToBuf[disp++] = col
    col++
  }
  bufToDisp[line.length] = disp
  dispToBuf[disp] = line.length
  return { text: out.join(""), bufToDisp, dispToBuf }
}

export function markdownDisplayFilter(buffer: BufferModel): DisplayFilterResult | null {
  const ranges = foldedRanges(buffer)
  const hideMarkup = markdownHideMarkup(buffer)
  const hideUrls = markdownHideUrls(buffer)
  if (!ranges.length && !hideMarkup) return null
  const src = buffer.text
  const cached = buffer.locals.get(MARKDOWN_FILTER_CACHE) as DisplayFilterCache | undefined
  if (cached
    && cached.text === src
    && cached.ranges === ranges
    && cached.hideMarkup === hideMarkup
    && cached.hideUrls === hideUrls) return cached.result

  const lines = src.split("\n")
  const L = lines.length
  const foldHidden = new Uint8Array(L)
  const skipHidden = new Uint8Array(L)
  for (const [a, b] of ranges)
    for (let i = Math.max(0, a); i <= b && i < L; i++) foldHidden[i] = 1

  const fenced = parseFencedCodeBlocks(src)
  const markupOps = hideMarkup ? collectMarkupHides(src, hideUrls) : []
  if (hideMarkup) {
    for (const block of fenced) {
      skipHidden[block.openLine] = 1
      // Closing fence: drop the delimiter line but keep the paragraph break after the block.
      skipHidden[block.closeLine] = 2
    }
  }

  const bufStart: number[] = new Array(L)
  const lineLen: number[] = new Array(L)
  for (let o = 0, i = 0; i < L; i++) { bufStart[i] = o; lineLen[i] = lines[i]!.length; o += lineLen[i]! + 1 }
  const opsByLine: MarkupOp[][] = Array.from({ length: L }, () => [])
  if (hideMarkup && markupOps.length) {
    let opIdx = 0
    for (let i = 0; i < L; i++) {
      const start = bufStart[i]!
      const end = start + lineLen[i]!
      while (opIdx < markupOps.length && markupOps[opIdx]!.end <= start) opIdx++
      for (let j = opIdx; j < markupOps.length && markupOps[j]!.start < end; j++) {
        if (markupOps[j]!.end > start) opsByLine[i]!.push(markupOps[j]!)
      }
    }
  }

  const dispStart: number[] = new Array(L)
  const displayLines: DisplayLineMap[] = []
  const lineDisplayMaps: Array<DisplayLineMap | undefined> = new Array(L)
  const parts: string[] = []
  let dispLen = 0
  let lastVisibleEnd = 0
  for (let i = 0; i < L; i++) {
    if (foldHidden[i] || skipHidden[i] === 1) { dispStart[i] = lastVisibleEnd; continue }
    if (skipHidden[i] === 2) {
      dispStart[i] = lastVisibleEnd
      const entry = { line: i, dispStart: dispLen, displayLen: 0 }
      displayLines.push(entry)
      lineDisplayMaps[i] = entry
      parts.push("\n")
      dispLen += 1
      lastVisibleEnd = dispLen
      continue
    }
    if (dispLen > 0) { parts.push("\n"); dispLen += 1 }
    dispStart[i] = dispLen
    const rendered = hideMarkup
      ? renderLineWithMarkupMap(lines[i]!, bufStart[i]!, opsByLine[i]!)
      : null
    const renderedText = rendered?.text ?? lines[i]!
    const entry = {
      line: i,
      dispStart: dispLen,
      displayLen: renderedText.length,
      bufToDisp: rendered?.bufToDisp,
      dispToBuf: rendered?.dispToBuf,
    }
    displayLines.push(entry)
    lineDisplayMaps[i] = entry
    parts.push(renderedText)
    dispLen += renderedText.length
    lastVisibleEnd = dispLen
    if (i + 1 < L && foldHidden[i + 1]) { parts.push("..."); dispLen += 3 }
  }
  const text = parts.join("")

  const map = (n: number): number => {
    const nn = Math.max(0, Math.min(n, src.length))
    let lo = 0, hi = L
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (bufStart[mid]! <= nn) lo = mid + 1; else hi = mid
    }
    const i = lo - 1
    if (foldHidden[i] || skipHidden[i]) return dispStart[i]! // 1 = invisible, 2 = paragraph break
    const col = nn - bufStart[i]!
    if (!hideMarkup) return dispStart[i]! + Math.min(col, lineLen[i]!)
    const rendered = lineDisplayMaps[i]
    return dispStart[i]! + (rendered?.bufToDisp?.[Math.min(col, lineLen[i]!)] ?? Math.min(col, lineLen[i]!))
  }
  const unmap = (n: number): number => {
    const nn = Math.max(0, Math.min(n, text.length))
    if (!displayLines.length) return 0
    let lo = 0, hi = displayLines.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (displayLines[mid]!.dispStart <= nn) lo = mid + 1; else hi = mid
    }
    const entry = displayLines[Math.max(0, lo - 1)]!
    const col = Math.max(0, Math.min(nn - entry.dispStart, entry.displayLen))
    const lineStart = bufStart[entry.line] ?? src.length
    const lineLength = lineLen[entry.line] ?? 0
    const bufCol = entry.dispToBuf?.[col] ?? Math.min(col, lineLength)
    return Math.max(0, Math.min(lineStart + bufCol, src.length))
  }
  const result = { text, map, unmap }
  buffer.locals.set(MARKDOWN_FILTER_CACHE, {
    text: src,
    ranges,
    hideMarkup,
    hideUrls,
    result,
  } satisfies DisplayFilterCache)
  return result
}

function cycleGlobalVisibility(editor: Editor, buffer: BufferModel): void {
  const prev = globalStatus(buffer)
  let next: GlobalCycle
  let message: string
  if (prev === 2) { next = 3; message = "CONTENTS" }
  else if (prev === 3) { next = 1; message = "SHOW ALL" }
  else { next = 2; message = "OVERVIEW" }
  setGlobalStatus(buffer, next)
  subtreeStatusMap(buffer).clear()
  syncFoldRanges(buffer)
  editor.message(message)
}

function trackIndentCommand(buffer: BufferModel, name: string): void {
  buffer.locals.set(MARKDOWN_LAST_INDENT, name)
}

function lastIndentCommand(buffer: BufferModel): string | null {
  return (buffer.locals.get(MARKDOWN_LAST_INDENT) as string | undefined) ?? null
}

export function markdownCalcIndents(text: string, lineStart: number): number[] {
  const positions = new Set<number>([0])
  const prev = previousLineStart(text, lineStart)
  const prevIndent = prev == null ? 0 : lineIndent(text, prev)
  positions.add(prevIndent)
  positions.add(prevIndent + TAB_WIDTH)
  if (prevIndent >= TAB_WIDTH) positions.add(prevIndent - TAB_WIDTH)

  if (prev != null) {
    const prevLine = text.slice(prev, lineEnd(text, prev))
    const listMatch = prevLine.match(LIST_RE)
    if (listMatch) {
      const markerEnd = prev + (listMatch[0]?.length ?? 0)
      positions.add(markerEnd - prev)
    }
  }

  const line = text.slice(lineStart, lineEnd(text, lineStart))
  if (BLOCKQUOTE_RE.test(line)) {
    const match = line.match(BLOCKQUOTE_RE)
    if (match) positions.add((match[1]?.length ?? 0) + 2)
  }
  if (FENCED_CODE_RE.test(line.trim())) positions.add(prevIndent + TAB_WIDTH)

  let cursor = lineStart
  while (cursor > 0) {
    const start = previousLineStart(text, cursor)
    if (start == null) break
    const body = text.slice(start, lineEnd(text, start))
    const list = body.match(LIST_RE)
    if (list) positions.add(lineIndent(text, start))
    if (ATX_HEADER_RE.test(body.trim())) break
    cursor = start
  }

  return [...positions].sort((a, b) => a - b)
}

export function markdownIndentLine(buffer: BufferModel, cycle = false): void {
  const line = buffer.lineBoundsAt()
  const positions = markdownCalcIndents(buffer.text, line.start)
  const content = line.text.replace(/^\s*/, "")
  const currentIndent = line.text.length - content.length
  const column = buffer.point - line.start

  let desired = positions[0] ?? 0
  if (content.length === 0) {
    const prev = previousLineStart(buffer.text, line.start)
    if (prev != null) {
      const prevLine = buffer.text.slice(prev, lineEnd(buffer.text, prev))
      const listMatch = prevLine.match(LIST_RE)
      if (listMatch) desired = listMatch[0]?.length ?? desired
    }
  }
  if (cycle || lastIndentCommand(buffer) === "markdown-cycle") {
    const idx = positions.indexOf(currentIndent)
    desired = positions[(idx + 1) % positions.length] ?? desired
  }

  buffer.replaceRange(line.start, line.end, " ".repeat(desired) + content)
  buffer.point = line.start + Math.max(desired, column + (desired - currentIndent))
}

function markdownOutdentLine(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const positions = markdownCalcIndents(buffer.text, line.start).sort((a, b) => a - b)
  const content = line.text.replace(/^\s*/, "")
  const currentIndent = line.text.length - content.length
  const column = buffer.point - line.start
  let desired = 0
  for (const pos of positions) {
    if (pos < currentIndent) desired = pos
  }
  buffer.replaceRange(line.start, line.end, " ".repeat(desired) + content)
  buffer.point = line.start + Math.max(desired, column + (desired - currentIndent))
}

function markdownHeaderFace(level: number): FaceName {
  return `markdown-header-face-${Math.min(6, Math.max(1, level))}` as FaceName
}

function overlayMarkdownHeaderFaces(text: string, spans: TextSpan[], range?: FontLockRange): TextSpan[] {
  const headings = markdownParseHeadingsInRange(text, range)
  if (!headings.length) return spans
  const headerSpans = headings.map(h => ({
    start: h.start,
    end: h.end,
    face: markdownHeaderFace(h.level),
  }))
  const filtered = spans.filter(span =>
    !headings.some(h => span.start >= h.start && span.end <= h.end),
  )
  return [...filtered, ...headerSpans].sort((a, b) => a.start - b.start || a.end - b.end)
}

function markdownParseHeadingsInRange(text: string, range?: FontLockRange): MarkdownHeading[] {
  if (!range) return markdownParseHeadings(text)
  const start = Math.max(0, range.start)
  const lines = text.slice(start, range.end).split("\n")
  const headings: MarkdownHeading[] = []
  let offset = start
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const atx = line.match(/^(\s*)(#{1,6})\s+(.*)$/)
    if (atx) {
      headings.push({
        line: range.startLine + i,
        start: offset,
        end: offset + line.length,
        level: atx[2]!.length,
        title: atx[3] ?? "",
      })
    } else if (i + 1 < lines.length && line.trim()) {
      const setext = SETEXT_UNDERLINE_RE.exec(lines[i + 1]!)
      if (setext && !line.match(/^#{1,6}\s/)) {
        headings.push({
          line: range.startLine + i,
          start: offset,
          end: offset + line.length,
          level: setext[2]!.startsWith("=") ? 1 : 2,
          title: line.trim(),
        })
      }
    }
    offset += line.length + 1
  }
  return headings
}

function fenceLineSpan(buffer: BufferModel, line: number): TextSpan | null {
  if (line < 0 || line >= buffer.lineCount) return null
  const [start, end] = buffer.lineBounds(line)
  return { start, end, face: "string" }
}

function markdownFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const mdLang = buffer.mode === "gfm" ? "gfm" : "markdown"
  const blocks = parseFencedCodeBlocks(buffer.text).filter(block => !range || block.bodyEnd >= range.start && block.bodyStart <= range.end)
  const native = markdownFontifyCodeBlocksNatively(buffer)
  const bodyRegions = blocks.map(b => [b.bodyStart, b.bodyEnd] as const)

  let spans = treeSitterFontLock(mdLang, buffer, range)
  if (bodyRegions.length) {
    spans = spans.filter(s => !spanInsideRegions(s.start, s.end, bodyRegions))
  }

  for (const block of blocks) {
    const openSpan = fenceLineSpan(buffer, block.openLine)
    const closeSpan = fenceLineSpan(buffer, block.closeLine)
    if (openSpan) spans.push(openSpan)
    if (closeSpan) spans.push(closeSpan)

    const bodyStart = range ? Math.max(block.bodyStart, range.start) : block.bodyStart
    const bodyEnd = range ? Math.min(block.bodyEnd, range.end) : block.bodyEnd
    const body = buffer.text.slice(bodyStart, bodyEnd)
    if (!body) continue
    if (native) {
      for (const span of markdownFontifyCodeBlockNatively(block.lang, body)) {
        spans.push({
          start: bodyStart + span.start,
          end: bodyStart + span.end,
          face: span.face,
        })
      }
    } else {
      spans.push({ start: bodyStart, end: bodyEnd, face: "string" })
    }
  }

  return overlayMarkdownHeaderFaces(buffer.text, spans, range)
}

function applyMarkdownFaceRemap(buffer: BufferModel): void {
  faceRemapAddRelative(buffer, "default", { family: VARIABLE_PITCH_FAMILY })
  // Code spans / fences / fenced bodies all font-lock as `string`; pin them to
  // fixed-pitch so they stay monospace under the variable-pitch default remap.
  faceRemapAddRelative(buffer, "string", { family: FIXED_PITCH_FAMILY })
  for (const [face, scale] of MARKDOWN_HEADER_FACES) {
    faceRemapAddRelative(buffer, face, { heightScale: scale })
  }
  buffer.minorModes.delete("linum-mode")
  buffer.locals.set(MARKDOWN_FILL_COLUMN, getCustom<number>("markdown-fill-column") ?? 100)
  buffer.locals.set(MARKDOWN_VISUAL_FILL, true)
  buffer.locals.set("markdown-visual-fill-column-center-text", getCustom<boolean>("markdown-visual-fill-column-center-text") ?? true)
  buffer.locals.set("word-wrap", getCustom<boolean>("word-wrap") ?? true)
  buffer.locals.set("adaptive-wrap-prefix-mode", true)
}

function applyMarkdownViewModeEnter(buffer: BufferModel): void {
  applyMarkdownFaceRemap(buffer)
  if (getCustom<boolean>("markdown-hide-markup-in-view-modes") ?? true) {
    setMarkdownHideMarkup(buffer, true)
  }
}

function markdownToggleCheckboxAtPoint(buffer: BufferModel, point: number): boolean {
  return markdownToggleCheckbox(buffer, point, true).changed
}

function markdownToggleCheckbox(buffer: BufferModel, point: number, requireCheckboxHit = false): MarkdownEditResult {
  const clamped = Math.max(0, Math.min(point, buffer.text.length))
  const lineStart = buffer.text.lastIndexOf("\n", Math.max(0, clamped - 1)) + 1
  const nextNewline = buffer.text.indexOf("\n", lineStart)
  const lineEnd = nextNewline === -1 ? buffer.text.length : nextNewline
  const line = buffer.text.slice(lineStart, lineEnd)
  const match = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/.exec(line)
  if (!match) return { changed: false, message: "No checkbox at point" }
  const markerStart = lineStart + match[1]!.length - 1
  const markerEnd = markerStart + 3
  if (requireCheckboxHit && (clamped < markerStart || clamped > markerEnd)) {
    return { changed: false, message: "No checkbox at point" }
  }
  const checkPoint = lineStart + match[1]!.length
  const next = match[2] === " " ? "x" : " "
  buffer.replaceRange(checkPoint, checkPoint + 1, next)
  buffer.point = checkPoint
  return { changed: true, message: next === "x" ? "Checked checkbox" : "Unchecked checkbox" }
}

function bindMarkdownModeMap(keymap: Keymap): void {
  keymap.bind("return", "jemacs-clear-whitespace-and-newline-and-indent")
  keymap.bind("enter", "jemacs-clear-whitespace-and-newline-and-indent")
  keymap.bind("C-m", "jemacs-clear-whitespace-and-newline-and-indent")
  keymap.bind("tab", "markdown-cycle")
  keymap.bind("C-i", "markdown-cycle")
  keymap.bind("S-tab", "markdown-shifttab")
  keymap.bind("backspace", "markdown-outdent-or-delete")
  keymap.bind("C-c >", "markdown-indent-region")
  keymap.bind("C-c <", "markdown-outdent-region")
  keymap.bind("C-c C-l", "markdown-insert-link")
  keymap.bind("C-c C-k", "markdown-kill-thing-at-point")
  keymap.bind("C-c C--", "markdown-promote")
  keymap.bind("C-c C-=", "markdown-demote")
  keymap.bind("M-left", "markdown-promote")
  keymap.bind("M-right", "markdown-demote")
  keymap.bind("M-up", "markdown-move-up")
  keymap.bind("M-down", "markdown-move-down")
  keymap.bind("C-c left", "markdown-promote")
  keymap.bind("C-c right", "markdown-demote")
  keymap.bind("C-c up", "markdown-move-up")
  keymap.bind("C-c down", "markdown-move-down")
  keymap.bind("S-M-left", "markdown-promote-subtree")
  keymap.bind("M-S-left", "markdown-promote-subtree")
  keymap.bind("S-M-right", "markdown-demote-subtree")
  keymap.bind("M-S-right", "markdown-demote-subtree")
  keymap.bind("C-c C-n", "markdown-outline-next")
  keymap.bind("C-c C-p", "markdown-outline-previous")
  keymap.bind("C-c C-f", "markdown-outline-next-same-level")
  keymap.bind("C-c C-b", "markdown-outline-previous-same-level")
  keymap.bind("C-c C-u", "markdown-outline-up")
  keymap.bind("C-c C-j", "markdown-insert-list-item")
  keymap.bind("M-RET", "markdown-insert-list-item")
  keymap.bind("C-c C-x [", "markdown-insert-gfm-checkbox")
  keymap.bind("C-c C-x C-x", "markdown-toggle-gfm-checkbox")
  keymap.bind("C-c -", "markdown-insert-hr")
  keymap.bind("C-c C-o", "markdown-follow-thing-at-point")
  keymap.bind("C-c C-t 1", "markdown-insert-header-atx-1")
  keymap.bind("C-c C-t 2", "markdown-insert-header-atx-2")
  keymap.bind("C-c C-t 3", "markdown-insert-header-atx-3")
  keymap.bind("C-c C-t 4", "markdown-insert-header-atx-4")
  keymap.bind("C-c C-t 5", "markdown-insert-header-atx-5")
  keymap.bind("C-c C-t 6", "markdown-insert-header-atx-6")
  keymap.bind("C-c C-t !", "markdown-insert-header-setext-1")
  keymap.bind("C-c C-t @", "markdown-insert-header-setext-2")
  keymap.bind("C-c C-t h", "markdown-insert-header-dwim")
  keymap.bind("C-a", "markdown-beginning-of-line")
  keymap.bind("C-e", "markdown-end-of-line")
  keymap.bind("M-{", "markdown-backward-paragraph")
  keymap.bind("M-}", "markdown-forward-paragraph")
  keymap.bind("esc {", "markdown-backward-paragraph")
  keymap.bind("esc }", "markdown-forward-paragraph")
  keymap.bind("M-n", "markdown-next-link")
  keymap.bind("M-p", "markdown-previous-link")
  // C-c C-s style prefix (markdown-mode-style-map)
  keymap.bind("C-c C-s b", "markdown-insert-bold")
  keymap.bind("C-c C-s i", "markdown-insert-italic")
  keymap.bind("C-c C-s c", "markdown-insert-code")
  keymap.bind("C-c C-s C", "markdown-insert-gfm-code-block")
  keymap.bind("C-c C-s q", "markdown-insert-blockquote")
  keymap.bind("C-c C-s -", "markdown-insert-hr")
  keymap.bind("C-c C-s 1", "markdown-insert-header-atx-1")
  keymap.bind("C-c C-s 2", "markdown-insert-header-atx-2")
  keymap.bind("C-c C-s 3", "markdown-insert-header-atx-3")
  keymap.bind("C-c C-s 4", "markdown-insert-header-atx-4")
  keymap.bind("C-c C-s 5", "markdown-insert-header-atx-5")
  keymap.bind("C-c C-s 6", "markdown-insert-header-atx-6")
  keymap.bind("C-c C-x C-m", "markdown-toggle-markup-hiding")
  keymap.bind("C-c C-x C-l", "markdown-toggle-url-hiding")
  keymap.bind("C-c C-x C-f", "markdown-toggle-fontify-code-blocks-natively")
}

function installMarkdownCommands(editor: Editor): void {
  editor.command("markdown-enter-key", ({ buffer, editor }) => {
    trackIndentCommand(buffer, "markdown-enter-key")
    const line = buffer.lineBoundsAt()
    const trimmed = line.text.trim()
    if (LIST_RE.test(trimmed) && trimmed.replace(LIST_RE, "").trim() === "") {
      buffer.replaceRange(line.start, line.end, "")
      buffer.point = line.start
      buffer.insert("\n")
      markdownIndentLine(buffer)
      return
    }
    buffer.insert("\n")
    markdownIndentLine(buffer)
    editor.message("New line")
  }, "Insert a newline and indent like `markdown-mode`.")

  editor.command("jemacs-clear-whitespace-and-newline-and-indent", async ({ editor, buffer }) => {
    const lineBefore = buffer.lineAt(buffer.point)
    await editor.run("markdown-enter-key")
    const [start, end] = buffer.lineBounds(lineBefore)
    const lineText = buffer.text.slice(start, end)
    const trimmed = lineText.replace(/\s+$/, "")
    if (trimmed.length < lineText.length) {
      buffer.replaceRange(start + trimmed.length, end, "")
    }
    const [newStart] = buffer.lineBounds(lineBefore + 1)
    buffer.point = newStart
  }, "RET in markdown: newline, trim trailing space on previous line, return.")

  editor.command("markdown-indent-line", ({ buffer }) => {
    trackIndentCommand(buffer, "markdown-indent-line")
    markdownIndentLine(buffer)
  }, "Indent the current line using Markdown heuristics.")

  editor.command("markdown-cycle", async ({ editor, buffer, prefixArgument }) => {
    if (prefixArgument != null) {
      cycleGlobalVisibility(editor, buffer)
      return
    }

    const heading = markdownHeadingAtPoint(buffer.text, buffer.point)
    if (heading) {
      const headings = markdownParseHeadings(buffer.text)
      const lc = buffer.text.split("\n").length
      const subEnd = markdownSubtreeEndLine(headings, heading, lc)
      const status = subtreeStatusMap(buffer)
      const prev = status.get(heading.line)
      if (subEnd <= heading.line) {
        editor.message("EMPTY ENTRY")
        status.delete(heading.line)
      } else if (prev === "children") {
        status.set(heading.line, "subtree")
        editor.message("SUBTREE")
      } else if (prev === "folded") {
        status.set(heading.line, "children")
        editor.message("CHILDREN")
      } else {
        status.set(heading.line, "folded")
        editor.message("FOLDED")
      }
      syncFoldRanges(buffer)
      return
    }

    await editor.run("indent-for-tab-command")
  }, "Cycle heading visibility, or indent when not on a heading.")

  editor.command("markdown-shifttab", ({ editor, buffer }) => {
    cycleGlobalVisibility(editor, buffer)
  }, "Global heading visibility cycle (like S-TAB in markdown-mode).")

  editor.command("markdown-toggle-markup-hiding", ({ editor, buffer, prefixArgument }) => {
    const enabled = toggleBufferBoolean(buffer, () => markdownHideMarkup(buffer), setMarkdownHideMarkup, prefixArgument)
    editor.message(`markdown-mode markup hiding ${enabled ? "enabled" : "disabled"}`)
  }, "Toggle display of markup delimiters (`markdown-hide-markup`).")

  editor.command("markdown-toggle-url-hiding", ({ editor, buffer, prefixArgument }) => {
    const enabled = toggleBufferBoolean(buffer, () => markdownHideUrls(buffer), setMarkdownHideUrls, prefixArgument)
    editor.message(`markdown-mode URL hiding ${enabled ? "enabled" : "disabled"}`)
  }, "Toggle URL hiding in links (`markdown-hide-urls`).")

  editor.command("markdown-toggle-fontify-code-blocks-natively", ({ editor, buffer, prefixArgument }) => {
    const enabled = toggleBufferBoolean(
      buffer,
      () => markdownFontifyCodeBlocksNatively(buffer),
      setMarkdownFontifyCodeBlocksNatively,
      prefixArgument,
    )
    editor.message(`markdown-mode native code block fontification ${enabled ? "enabled" : "disabled"}`)
    editor.changed("markdown-toggle-fontify-code-blocks-natively")
  }, "Toggle native fontification of fenced code blocks (`markdown-fontify-code-blocks-natively`).")

  editor.command("markdown-view-mode", ({ editor, buffer }) => {
    editor.enterMode(buffer, "markdown-view-mode")
  }, "Enter read-oriented Markdown view mode with markup hiding.")

  editor.command("gfm-view-mode", ({ editor, buffer }) => {
    editor.enterMode(buffer, "gfm-view-mode")
  }, "Enter read-oriented GFM view mode with markup hiding.")

  editor.command("markdown-outdent-or-delete", ({ buffer }) => {
    if (buffer.deleteActiveRegion()) return
    const line = buffer.lineBoundsAt()
    const content = line.text.replace(/^\s*/, "")
    if (content.length === 0 && line.text.length > 0) {
      markdownOutdentLine(buffer)
      return
    }
    if (buffer.point > 0) buffer.deleteBackward()
  }, "Outdent when only whitespace precedes point, else delete backward.")

  editor.command("markdown-indent-region", ({ buffer }) => {
    const region = regionBounds(buffer)
    indentRegion(buffer, region.start, region.end, TAB_WIDTH)
  }, "Indent the active region.")

  editor.command("markdown-outdent-region", ({ buffer }) => {
    const region = regionBounds(buffer)
    indentRegion(buffer, region.start, region.end, -TAB_WIDTH)
  }, "Outdent the active region.")

  editor.command("markdown-insert-link", async ({ buffer, editor }) => {
    const url = await editor.prompt("URL or [reference]: ", "", "markdown-url")
    if (!url) return
    const region = activeRegion(buffer)
    if (region) {
      const text = buffer.text.slice(region.start, region.end)
      insertMarkdownLink(buffer, region.start, region.end, text, url)
      buffer.clearMark()
      editor.message("Inserted link")
      return
    }
    const text = await editor.prompt("Link text: ", "", "markdown-link-text")
    if (text == null) return
    insertMarkdownLink(buffer, buffer.point, buffer.point, text || url, url)
    editor.message("Inserted link")
  }, "Insert a Markdown inline link.")

  editor.command("markdown-insert-bold", ({ buffer, editor }) => {
    wrapOrInsert(buffer, "**", "**", "text")
    editor.message("Inserted bold")
  }, "Insert bold markup.")

  editor.command("markdown-insert-italic", ({ buffer, editor }) => {
    wrapOrInsert(buffer, "*", "*", "text")
    editor.message("Inserted italic")
  }, "Insert italic markup.")

  editor.command("markdown-insert-code", ({ buffer, editor }) => {
    wrapOrInsert(buffer, "`", "`", "code")
    editor.message("Inserted inline code")
  }, "Insert inline code markup.")

  editor.command("markdown-insert-gfm-code-block", ({ buffer, editor }) => {
    const line = buffer.lineBoundsAt()
    const block = "```\n\n```\n"
    if (line.text.trim()) buffer.insert(`\n${block}`)
    else buffer.replaceRange(line.start, line.end, block)
    buffer.point = buffer.text.indexOf("```\n\n") + 4
    editor.message("Inserted GFM code block")
  }, "Insert a fenced GFM code block.")

  editor.command("markdown-insert-blockquote", ({ buffer, editor }) => {
    const line = buffer.lineBoundsAt()
    const content = line.text.replace(/^\s*/, "")
    buffer.replaceRange(line.start, line.end, `> ${content}`)
    editor.message("Inserted blockquote")
  }, "Prefix the current line with a blockquote marker.")

  editor.command("markdown-insert-list-item", ({ buffer, editor }) => {
    insertMarkdownListItem(buffer)
    editor.message("Inserted list item")
  }, "Start a new list item on the next line.")

  editor.command("markdown-insert-gfm-checkbox", ({ buffer, editor }) => {
    const result = insertMarkdownCheckbox(buffer)
    editor.message(result.message)
  }, "Insert a GFM task list checkbox.")

  editor.command("markdown-toggle-gfm-checkbox", ({ buffer, editor }) => {
    const result = markdownToggleCheckbox(buffer, buffer.point)
    editor.message(result.message)
  }, "Toggle the GFM task list checkbox at point.")

  editor.command("markdown-cleanup-list-numbers", ({ buffer, editor }) => {
    const result = markdownCleanupListNumbers(buffer)
    editor.message(result.message)
  }, "Renumber ordered Markdown lists in the buffer.")

  editor.command("markdown-insert-hr", ({ buffer, editor }) => {
    const line = buffer.lineBoundsAt()
    const hr = `${"-".repeat(5)}\n`
    if (line.text.trim()) buffer.insert(`\n${hr}`)
    else buffer.replaceRange(line.start, line.end, hr)
    editor.message("Inserted horizontal rule")
  }, "Insert a horizontal rule.")

  for (let level = 1; level <= 6; level++) {
    const name = `markdown-insert-header-atx-${level}`
    editor.command(name, ({ buffer, editor }) => {
      insertAtxHeader(buffer, level)
      editor.message(`Inserted ATX header level ${level}`)
    }, `Insert a level-${level} ATX header.`)
  }

  editor.command("markdown-insert-header-setext-1", ({ buffer, editor }) => {
    insertSetextHeader(buffer, 1)
    editor.message("Inserted setext level-1 header")
  }, "Insert a level-1 setext header.")

  editor.command("markdown-insert-header-setext-2", ({ buffer, editor }) => {
    insertSetextHeader(buffer, 2)
    editor.message("Inserted setext level-2 header")
  }, "Insert a level-2 setext header.")

  editor.command("markdown-insert-header-dwim", ({ buffer, editor }) => {
    const line = buffer.lineBoundsAt()
    if (/^#{1,6}\s/.test(line.text.trim())) changeHeaderLevel(buffer, 1)
    else insertAtxHeader(buffer, 1)
    editor.message("Inserted or demoted header")
  }, "Insert or demote an ATX header at point.")

  editor.command("markdown-promote", ({ buffer, editor }) => {
    const result = markdownPromoteOrDemote(buffer, -1)
    editor.message(result.message)
  }, "Promote the heading or list item at point.")

  editor.command("markdown-demote", ({ buffer, editor }) => {
    const result = markdownPromoteOrDemote(buffer, 1)
    editor.message(result.message)
  }, "Demote the heading or list item at point.")

  editor.command("markdown-promote-subtree", ({ buffer, editor }) => {
    const result = markdownPromoteOrDemoteSubtree(buffer, -1)
    editor.message(result.message)
  }, "Promote the current heading subtree.")

  editor.command("markdown-demote-subtree", ({ buffer, editor }) => {
    const result = markdownPromoteOrDemoteSubtree(buffer, 1)
    editor.message(result.message)
  }, "Demote the current heading subtree.")

  editor.command("markdown-move-subtree-up", ({ buffer, editor }) => {
    const result = markdownMoveSubtree(buffer, -1)
    editor.message(result.message)
  }, "Move the current heading subtree before its previous sibling.")

  editor.command("markdown-move-subtree-down", ({ buffer, editor }) => {
    const result = markdownMoveSubtree(buffer, 1)
    editor.message(result.message)
  }, "Move the current heading subtree after its next sibling.")

  editor.command("markdown-move-list-item-up", ({ buffer, editor }) => {
    const result = markdownMoveListItem(buffer, -1)
    editor.message(result.message)
  }, "Move the current Markdown list item before its previous sibling.")

  editor.command("markdown-move-list-item-down", ({ buffer, editor }) => {
    const result = markdownMoveListItem(buffer, 1)
    editor.message(result.message)
  }, "Move the current Markdown list item after its next sibling.")

  editor.command("markdown-move-up", ({ buffer, editor }) => {
    const heading = markdownHeadingAtPointIncludingSetextUnderline(buffer.text, buffer.point)
    const result = heading ? markdownMoveSubtree(buffer, -1) : markdownMoveListItem(buffer, -1)
    editor.message(result.message)
  }, "Move the current heading subtree or list item up.")

  editor.command("markdown-move-down", ({ buffer, editor }) => {
    const heading = markdownHeadingAtPointIncludingSetextUnderline(buffer.text, buffer.point)
    const result = heading ? markdownMoveSubtree(buffer, 1) : markdownMoveListItem(buffer, 1)
    editor.message(result.message)
  }, "Move the current heading subtree or list item down.")

  editor.command("markdown-insert-strike-through", ({ buffer, editor }) => {
    wrapOrInsert(buffer, "~~", "~~", "text")
    editor.message("Inserted strike-through")
  }, "Insert GFM strike-through markup.")

  editor.command("markdown-kill-thing-at-point", ({ buffer, editor }) => {
    const line = buffer.lineBoundsAt()
    const match = line.text.match(/^(\s*)(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/)
    if (match) {
      const end = line.start + (match[0]?.length ?? 0)
      buffer.deleteRange(line.start, end)
      editor.message("Killed markup")
      return
    }
    editor.message("Nothing to kill at point")
  }, "Kill markup prefix at beginning of line.")

  editor.command("markdown-follow-thing-at-point", ({ buffer, editor }) => {
    const url = linkUrlAtPoint(buffer.text, buffer.point)
    if (!url) { editor.message("No link at point"); return }
    void spawnUrl(url)
    editor.message(`Followed ${url}`)
  }, "Follow link at point.")

  editor.command("markdown-next-link", ({ buffer, editor }) => {
    const next = findLink(buffer.text, buffer.point, 1)
    if (next == null) { editor.message("No next link"); return }
    buffer.point = next
  }, "Move to next Markdown link.")

  editor.command("markdown-previous-link", ({ buffer, editor }) => {
    const prev = findLink(buffer.text, buffer.point, -1)
    if (prev == null) { editor.message("No previous link"); return }
    buffer.point = prev
  }, "Move to previous Markdown link.")

  editor.command("markdown-beginning-of-line", ({ buffer }) => {
    const line = buffer.lineBoundsAt()
    const text = line.text
    const contentStart = text.match(/^\s*/)?.[0].length ?? 0
    const marker = text.slice(contentStart).match(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/)?.[0].length ?? 0
    const target = line.start + contentStart + marker
    buffer.point = buffer.point <= target ? line.start : target
  }, "Move to meaningful beginning of line in Markdown context.")

  editor.command("markdown-end-of-line", ({ buffer }) => {
    const line = buffer.lineBoundsAt()
    buffer.point = line.end
  }, "Move to end of line.")

  editor.command("markdown-forward-paragraph", ({ buffer }) => {
    buffer.point = findParagraphBoundary(buffer.text, buffer.point, 1)
  }, "Move forward to the next paragraph boundary.")

  editor.command("markdown-backward-paragraph", ({ buffer }) => {
    buffer.point = findParagraphBoundary(buffer.text, buffer.point, -1)
  }, "Move backward to the previous paragraph boundary.")

  editor.command("markdown-outline-next", ({ buffer }) => {
    buffer.point = findHeading(buffer.text, buffer.point, 1, false)
  }, "Move to the next heading.")

  editor.command("markdown-outline-previous", ({ buffer }) => {
    buffer.point = findHeading(buffer.text, buffer.point, -1, false)
  }, "Move to the previous heading.")

  editor.command("markdown-outline-next-same-level", ({ buffer }) => {
    const level = headingLevelAt(buffer.text, buffer.point)
    buffer.point = findHeading(buffer.text, buffer.point, 1, true, level)
  }, "Move to the next heading at the same level.")

  editor.command("markdown-outline-previous-same-level", ({ buffer }) => {
    const level = headingLevelAt(buffer.text, buffer.point)
    buffer.point = findHeading(buffer.text, buffer.point, -1, true, level)
  }, "Move to the previous heading at the same level.")

  editor.command("markdown-outline-up", ({ buffer }) => {
    const level = headingLevelAt(buffer.text, buffer.point)
    if (level <= 1) return
    buffer.point = findHeading(buffer.text, buffer.point, -1, true, level - 1)
  }, "Move to the parent heading.")

  editor.command("markdown-mode", ({ editor, buffer }) => editor.enterMode(buffer, "markdown"),
    "Major mode for editing Markdown files.")
}

export function install(editor: Editor): void {
  registerTreeSitterGrammars()
  installMarkdownCommands(editor)

  for (const [name] of MARKDOWN_HEADER_FACES) defface(name, {}, "Markdown ATX/setext header face.")
  defface("markdown-emphasis", { italic: true }, "Markdown italic emphasis.")
  defface("markdown-strong", { bold: true }, "Markdown bold emphasis.")
  const keymap = new Keymap("markdown-map")
  bindMarkdownModeMap(keymap)

  defineMode({
    name: "markdown",
    parent: "text",
    commentStart: "<!--",
    keymap,
    indentLine: markdownIndentLine,
    fontLock: markdownFontLock,
    displayFilter: markdownDisplayFilter,
    mouseClick: markdownToggleCheckboxAtPoint,
    onEnter: applyMarkdownFaceRemap,
  })

  const gfmKeymap = new Keymap("gfm-map")
  gfmKeymap.bind("C-c C-s d", "markdown-insert-strike-through")
  defineMode({
    name: "gfm",
    parent: "markdown",
    keymap: gfmKeymap,
    fontLock: markdownFontLock,
    onEnter: applyMarkdownFaceRemap,
  })

  defineMode({
    name: "markdown-view-mode",
    parent: "markdown",
    onEnter: applyMarkdownViewModeEnter,
  })

  defineMode({
    name: "gfm-view-mode",
    parent: "gfm",
    onEnter: applyMarkdownViewModeEnter,
  })

  addHook("find-file-hook", ({ buffer }) => {
    if (!buffer.path) return
    const mode = /\.md$/i.test(buffer.path) && /README\.md$/i.test(buffer.path) ? "gfm"
      : /\.(?:md|markdown|mkd|mdown|mkdn|mdwn)$/i.test(buffer.path) ? "markdown"
      : null
    if (mode) enterMode(buffer, mode)
  })
}

function wrapOrInsert(buffer: BufferModel, open: string, close: string, placeholder: string): void {
  const region = activeRegion(buffer)
  if (region) {
    const text = buffer.text.slice(region.start, region.end)
    buffer.replaceRange(region.start, region.end, `${open}${text}${close}`)
    buffer.point = region.end + open.length + close.length
    buffer.clearMark()
    return
  }
  buffer.insert(`${open}${placeholder}${close}`)
  buffer.point -= close.length + placeholder.length
}

function insertMarkdownLink(buffer: BufferModel, start: number, end: number, text: string, url: string): void {
  const link = `[${text}](${url})`
  buffer.replaceRange(start, end, link)
  buffer.point = start + link.length
}

function insertMarkdownListItem(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const match = line.text.match(LIST_RE)
  const indent = match?.[1] ?? ""
  const ordered = match?.[2]?.match(/^(\d+)([.)])$/)
  const marker = ordered ? `${Number(ordered[1]) + 1}${ordered[2]} ` : "- "
  const insertPoint = buffer.point
  buffer.insert(`\n${indent}${marker}`)
  if (ordered) {
    const insertedLine = buffer.text.slice(0, insertPoint).split("\n").length
    renumberOrderedListContainingLine(buffer, insertedLine, indent.length)
  }
}

function insertMarkdownCheckbox(buffer: BufferModel): MarkdownEditResult {
  const line = buffer.lineBoundsAt()
  const checkboxList = /^(\s*)(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/.exec(line.text)
  if (checkboxList) {
    buffer.insert(`\n${checkboxList[1]}- [ ] `)
    return { changed: true, message: "Inserted checkbox" }
  }

  const list = line.text.match(LIST_RE)
  if (list && line.text.slice(list[0]!.length).trim()) {
    const markerEnd = line.start + list[0]!.length
    buffer.replaceRange(markerEnd, markerEnd, "[ ] ")
    buffer.point = markerEnd + "[ ] ".length
    return { changed: true, message: "Inserted checkbox" }
  }
  if (list) {
    buffer.insert(`\n${list[1]}- [ ] `)
    return { changed: true, message: "Inserted checkbox" }
  }

  const indent = line.text.match(/^\s*/)?.[0] ?? ""
  const content = line.text.slice(indent.length)
  if (content.trim()) {
    const replacement = `${indent}- [ ] ${content}`
    buffer.replaceRange(line.start, line.end, replacement)
    buffer.point = line.start + `${indent}- [ ] `.length
    return { changed: true, message: "Inserted checkbox" }
  }

  buffer.replaceRange(line.start, line.end, `${indent}- [ ] `)
  buffer.point = line.start + `${indent}- [ ] `.length
  return { changed: true, message: "Inserted checkbox" }
}

function markdownCleanupListNumbers(buffer: BufferModel): MarkdownEditResult {
  const lines = buffer.text.split("\n")
  const counters = new Map<number, number>()
  const activeIndents = new Set<number>()
  let changed = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const list = line.match(LIST_RE)
    if (list) {
      const indent = list[1]!.length
      for (const active of [...activeIndents]) {
        if (active > indent) activeIndents.delete(active)
      }
      activeIndents.add(indent)
      for (const key of [...counters.keys()]) {
        if (key > indent) counters.delete(key)
      }

      const ordered = line.match(ORDERED_LIST_RE)
      if (!ordered) {
        counters.delete(indent)
        continue
      }

      const next = (counters.get(indent) ?? 0) + 1
      counters.set(indent, next)
      if (Number(ordered[2]) !== next) {
        lines[i] = `${ordered[1]}${next}${ordered[3]}${line.slice(ordered[0]!.length - 1)}`
        changed = true
      }
      continue
    }

    if (!line.trim()) {
      counters.clear()
      activeIndents.clear()
      continue
    }

    const indent = line.match(/^\s*/)?.[0].length ?? 0
    if (![...activeIndents].some(active => indent > active)) {
      counters.clear()
      activeIndents.clear()
    }
  }

  if (!changed) return { changed: false, message: "List numbers already clean" }
  const point = buffer.point
  buffer.replaceRange(0, buffer.text.length, lines.join("\n"))
  buffer.point = Math.min(point, buffer.text.length)
  return { changed: true, message: "Cleaned up list numbers" }
}

function renumberOrderedListContainingLine(buffer: BufferModel, lineNumber: number, targetIndent: number): void {
  const lines = buffer.text.split("\n")
  if (!lines[lineNumber]?.match(ORDERED_LIST_RE)) return

  let start = lineNumber
  for (let i = lineNumber - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.trim()) break
    const list = line.match(LIST_RE)
    const indent = list?.[1]?.length
    if (list && indent != null && indent < targetIndent) break
    if (list && indent === targetIndent && !ORDERED_LIST_RE.test(line)) break
    if (!list && (line.match(/^\s*/)?.[0].length ?? 0) <= targetIndent) break
    start = i
  }

  let end = lineNumber
  for (let i = lineNumber + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim()) break
    const list = line.match(LIST_RE)
    const indent = list?.[1]?.length
    if (list && indent != null && indent < targetIndent) break
    if (list && indent === targetIndent && !ORDERED_LIST_RE.test(line)) break
    if (!list && (line.match(/^\s*/)?.[0].length ?? 0) <= targetIndent) break
    end = i
  }

  const first = lines.slice(start, end + 1)
    .map(line => line.match(ORDERED_LIST_RE))
    .find(match => match && match[1]!.length === targetIndent)
  if (!first) return

  let next = Number(first[2])
  let changed = false
  for (let i = start; i <= end; i++) {
    const ordered = lines[i]!.match(ORDERED_LIST_RE)
    if (!ordered || ordered[1]!.length !== targetIndent) continue
    if (Number(ordered[2]) !== next) {
      lines[i] = `${ordered[1]}${next}${ordered[3]}${lines[i]!.slice(ordered[0]!.length - 1)}`
      changed = true
    }
    next++
  }
  if (!changed) return

  const point = buffer.point
  buffer.replaceRange(0, buffer.text.length, lines.join("\n"))
  buffer.point = Math.min(point, buffer.text.length)
}

function insertAtxHeader(buffer: BufferModel, level: number): void {
  const hashes = "#".repeat(level) + " "
  const region = activeRegion(buffer)
  if (region) {
    const text = buffer.text.slice(region.start, region.end).replace(/^#+\s*/, "")
    buffer.replaceRange(region.start, region.end, `${hashes}${text}`)
    return
  }
  const line = buffer.lineBoundsAt()
  const trimmed = line.text.trimStart()
  if (trimmed) buffer.replaceRange(line.start, line.end, `${hashes}${trimmed}`)
  else buffer.insert(`${hashes}Heading ${level}`)
}

function insertSetextHeader(buffer: BufferModel, level: 1 | 2): void {
  const underline = (level === 1 ? "=" : "-").repeat(3)
  const line = buffer.lineBoundsAt()
  const title = line.text.trim() || "Heading"
  buffer.replaceRange(line.start, line.end, `${title}\n${underline}`)
  buffer.point = line.start + title.length
}

function changeHeaderLevel(buffer: BufferModel, delta: number): void {
  const line = buffer.lineBoundsAt()
  const match = line.text.match(/^(\s*)(#{1,6})(\s*)(.*)$/)
  if (!match) return
  const level = Math.min(6, Math.max(1, match[2]!.length + delta))
  const replacement = `${match[1]}${"#".repeat(level)}${match[3]}${match[4]}`
  buffer.replaceRange(line.start, line.end, replacement)
}

type MarkdownEditResult = { changed: boolean; message: string }
type MarkdownListItem = { line: number; endLine: number; indent: number }

function markdownHeadingAtPointIncludingSetextUnderline(text: string, point: number): MarkdownHeading | null {
  const line = text.slice(0, point).split("\n").length - 1
  return markdownParseHeadings(text).find(h => h.line === line || (h.line + 1 === line && isSetextUnderlineLine(text, line))) ?? null
}

function isSetextUnderlineLine(text: string, line: number): boolean {
  const lines = text.split("\n")
  return line > 0 && line < lines.length && SETEXT_UNDERLINE_RE.test(lines[line]!) && !!lines[line - 1]!.trim()
}

function lineStartAt(text: string, line: number): number {
  if (line <= 0) return 0
  let offset = 0
  const lines = text.split("\n")
  for (let i = 0; i < line && i < lines.length; i++) offset += lines[i]!.length + 1
  return Math.min(offset, text.length)
}

function replaceLines(buffer: BufferModel, startLine: number, endLine: number, replacement: string[]): void {
  const lines = buffer.text.split("\n")
  lines.splice(startLine, endLine - startLine + 1, ...replacement)
  buffer.replaceRange(0, buffer.text.length, lines.join("\n"))
}

function markdownPromoteOrDemote(buffer: BufferModel, delta: -1 | 1): MarkdownEditResult {
  const line = buffer.lineBoundsAt()
  if (LIST_RE.test(line.text)) {
    indentRegion(buffer, line.start, line.end, delta > 0 ? TAB_WIDTH : -TAB_WIDTH)
    buffer.point = line.start
    return { changed: true, message: delta > 0 ? "Demoted list item" : "Promoted list item" }
  }

  const heading = markdownHeadingAtPointIncludingSetextUnderline(buffer.text, buffer.point)
  if (!heading) return { changed: false, message: "No heading or list item at point" }
  return changeMarkdownHeadingLevel(buffer, heading, delta)
}

function changeMarkdownHeadingLevel(buffer: BufferModel, heading: MarkdownHeading, delta: -1 | 1): MarkdownEditResult {
  const lines = buffer.text.split("\n")
  const line = lines[heading.line] ?? ""
  const atx = line.match(/^(\s*)(#{1,6})(\s+)(.*)$/)
  if (atx) {
    const next = atx[2]!.length + delta
    if (next < 1) return { changed: false, message: "Cannot promote further" }
    if (next > 6) return { changed: false, message: "Cannot demote further" }
    lines[heading.line] = `${atx[1]}${"#".repeat(next)}${atx[3]}${atx[4]}`
    buffer.replaceRange(0, buffer.text.length, lines.join("\n"))
    buffer.point = lineStartAt(buffer.text, heading.line)
    return { changed: true, message: delta > 0 ? "Demoted heading" : "Promoted heading" }
  }

  const underline = lines[heading.line + 1] ?? ""
  const setext = SETEXT_UNDERLINE_RE.exec(underline)
  if (!setext) return { changed: false, message: "No heading at point" }
  const underlineIndent = setext[1] ?? ""
  const underlineText = setext[2] ?? ""
  const width = Math.max(3, underlineText.length)
  if (delta < 0) {
    if (heading.level <= 1) return { changed: false, message: "Cannot promote further" }
    lines[heading.line + 1] = `${underlineIndent}${"=".repeat(width)}`
    buffer.replaceRange(0, buffer.text.length, lines.join("\n"))
    buffer.point = lineStartAt(buffer.text, heading.line)
    return { changed: true, message: "Promoted heading" }
  }
  if (heading.level === 1) {
    lines[heading.line + 1] = `${underlineIndent}${"-".repeat(width)}`
    buffer.replaceRange(0, buffer.text.length, lines.join("\n"))
    buffer.point = lineStartAt(buffer.text, heading.line)
    return { changed: true, message: "Demoted heading" }
  }
  replaceLines(buffer, heading.line, heading.line + 1, [`### ${line.trim()}`])
  buffer.point = lineStartAt(buffer.text, heading.line)
  return { changed: true, message: "Demoted heading" }
}

function markdownPromoteOrDemoteSubtree(buffer: BufferModel, delta: -1 | 1): MarkdownEditResult {
  const root = markdownHeadingAtPointIncludingSetextUnderline(buffer.text, buffer.point)
  if (!root) return { changed: false, message: "No heading at point" }
  const headings = markdownParseHeadings(buffer.text)
  const lineCount = buffer.text.split("\n").length
  const endLine = markdownSubtreeEndLine(headings, root, lineCount)
  const subtree = headings.filter(h => h.line >= root.line && h.line <= endLine)
  if (delta < 0 && root.level <= 1) return { changed: false, message: "Cannot promote subtree further" }
  if (delta > 0 && subtree.some(h => h.level >= 6)) return { changed: false, message: "Cannot demote subtree further" }
  for (const heading of [...subtree].sort((a, b) => b.line - a.line)) {
    changeMarkdownHeadingLevel(buffer, heading, delta)
  }
  buffer.point = lineStartAt(buffer.text, root.line)
  return { changed: true, message: delta > 0 ? "Demoted subtree" : "Promoted subtree" }
}

function lineRangeTextBounds(buffer: BufferModel, startLine: number, endLine: number): { start: number; end: number } {
  const [start] = buffer.lineBounds(startLine)
  const [, endNoNewline] = buffer.lineBounds(endLine)
  return { start, end: endNoNewline < buffer.text.length ? endNoNewline + 1 : endNoNewline }
}

function markdownMoveSubtree(buffer: BufferModel, direction: -1 | 1): MarkdownEditResult {
  const heading = markdownHeadingAtPointIncludingSetextUnderline(buffer.text, buffer.point)
  if (!heading) return { changed: false, message: "No heading at point" }
  const headings = markdownParseHeadings(buffer.text)
  const lineCount = buffer.text.split("\n").length
  const currentEnd = markdownSubtreeEndLine(headings, heading, lineCount)
  const siblings = headings.filter(h => h.level === heading.level && h.line !== heading.line)
  const blocksLowerLevel = (fromLine: number, toLine: number) =>
    headings.some(h => h.line > fromLine && h.line < toLine && h.level < heading.level)
  const sibling = direction < 0
    ? [...siblings].reverse().find(h => h.line < heading.line && !blocksLowerLevel(h.line, heading.line))
    : siblings.find(h => h.line > currentEnd && !blocksLowerLevel(heading.line, h.line))
  if (!sibling) return { changed: false, message: direction < 0 ? "No previous subtree" : "No next subtree" }

  const siblingEnd = markdownSubtreeEndLine(headings, sibling, lineCount)
  if (direction < 0) {
    swapLineRanges(buffer, sibling.line, siblingEnd, heading.line, currentEnd)
    buffer.point = lineStartAt(buffer.text, sibling.line)
  } else {
    swapLineRanges(buffer, heading.line, currentEnd, sibling.line, siblingEnd)
    const movedLine = sibling.line + (siblingEnd - sibling.line + 1)
    buffer.point = lineStartAt(buffer.text, movedLine)
  }
  return { changed: true, message: direction < 0 ? "Moved subtree up" : "Moved subtree down" }
}

function parseMarkdownListItems(text: string): MarkdownListItem[] {
  const lines = text.split("\n")
  const starts: MarkdownListItem[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(LIST_RE)
    if (match) starts.push({ line: i, endLine: i, indent: match[1]!.length })
  }
  for (let i = 0; i < starts.length; i++) {
    const item = starts[i]!
    let end = lines.length - 1
    for (let j = i + 1; j < starts.length; j++) {
      if (starts[j]!.indent <= item.indent) {
        end = starts[j]!.line - 1
        break
      }
    }
    item.endLine = end
  }
  return starts
}

function currentMarkdownListItem(text: string, point: number): MarkdownListItem | null {
  const line = text.slice(0, point).split("\n").length - 1
  return parseMarkdownListItems(text)
    .filter(item => item.line <= line && item.endLine >= line)
    .sort((a, b) => b.line - a.line)[0] ?? null
}

function markdownMoveListItem(buffer: BufferModel, direction: -1 | 1): MarkdownEditResult {
  const current = currentMarkdownListItem(buffer.text, buffer.point)
  if (!current) return { changed: false, message: "No list item at point" }
  const items = parseMarkdownListItems(buffer.text)
  const blocksAncestor = (fromLine: number, toLine: number) =>
    items.some(item => item.line > fromLine && item.line < toLine && item.indent < current.indent)
  const sibling = direction < 0
    ? [...items].reverse().find(item => item.indent === current.indent && item.endLine < current.line && !blocksAncestor(item.line, current.line))
    : items.find(item => item.indent === current.indent && item.line > current.endLine && !blocksAncestor(current.line, item.line))
  if (!sibling) return { changed: false, message: direction < 0 ? "No previous list item" : "No next list item" }

  if (direction < 0) {
    swapLineRanges(buffer, sibling.line, sibling.endLine, current.line, current.endLine)
    buffer.point = lineStartAt(buffer.text, sibling.line)
  } else {
    swapLineRanges(buffer, current.line, current.endLine, sibling.line, sibling.endLine)
    const movedLine = sibling.line + (sibling.endLine - sibling.line + 1)
    buffer.point = lineStartAt(buffer.text, movedLine)
  }
  return { changed: true, message: direction < 0 ? "Moved list item up" : "Moved list item down" }
}

function swapLineRanges(buffer: BufferModel, aStartLine: number, aEndLine: number, bStartLine: number, bEndLine: number): void {
  const a = lineRangeTextBounds(buffer, aStartLine, aEndLine)
  const b = lineRangeTextBounds(buffer, bStartLine, bEndLine)
  const aText = buffer.text.slice(a.start, a.end)
  const between = buffer.text.slice(a.end, b.start)
  const bText = buffer.text.slice(b.start, b.end)
  buffer.replaceRange(a.start, b.end, `${bText}${between}${aText}`)
}

function indentRegion(buffer: BufferModel, start: number, end: number, delta: number): void {
  const lines = buffer.text.split("\n")
  let offset = 0
  const startLine = buffer.text.slice(0, start).split("\n").length - 1
  const endLine = buffer.text.slice(0, end).split("\n").length - 1
  for (let i = 0; i < lines.length; i++) {
    const lineStart = offset
    const lineEndPos = offset + lines[i]!.length
    if (i >= startLine && i <= endLine) {
      if (delta > 0) lines[i] = " ".repeat(delta) + lines[i]
      else lines[i] = lines[i]!.replace(new RegExp(`^ {0,${-delta}}`), "")
    }
    offset = lineEndPos + 1
  }
  buffer.replaceRange(0, buffer.text.length, lines.join("\n"))
}

function regionBounds(buffer: BufferModel): { start: number; end: number } {
  if (buffer.mark != null && buffer.mark !== buffer.point) {
    return { start: Math.min(buffer.mark, buffer.point), end: Math.max(buffer.mark, buffer.point) }
  }
  const line = buffer.lineBoundsAt()
  return { start: line.start, end: line.end < buffer.text.length ? line.end + 1 : line.end }
}

function activeRegion(buffer: BufferModel): { start: number; end: number } | null {
  if (buffer.mark == null || buffer.mark === buffer.point) return null
  return { start: Math.min(buffer.mark, buffer.point), end: Math.max(buffer.mark, buffer.point) }
}

function findParagraphBoundary(text: string, point: number, direction: 1 | -1): number {
  let offset = point
  const atBlank = isBlankLine(text, offset)
  if (direction === 1) {
    if (!atBlank) offset = nextLineStart(text, offset)
    while (offset < text.length && !isBlankLine(text, offset)) offset = nextLineStart(text, offset)
    while (offset < text.length && isBlankLine(text, offset)) offset = nextLineStart(text, offset)
    return Math.min(offset, text.length)
  }
  if (!atBlank) offset = previousLineStart(text, offset) ?? 0
  while (offset > 0 && !isBlankLine(text, offset)) offset = previousLineStart(text, offset) ?? 0
  while (offset > 0 && isBlankLine(text, offset)) offset = previousLineStart(text, offset) ?? 0
  return offset
}

function findHeading(text: string, point: number, direction: 1 | -1, sameLevel: boolean, level?: number): number {
  const positions = markdownParseHeadings(text).map(h => ({ index: h.start, level: h.level }))
  if (direction === 1) {
    for (const pos of positions) {
      if (pos.index <= point) continue
      if (sameLevel && level != null && pos.level !== level) continue
      return pos.index
    }
    return text.length
  }
  let target = 0
  for (const pos of positions) {
    if (pos.index >= point) break
    if (sameLevel && level != null && pos.level !== level) continue
    target = pos.index
  }
  return target
}

function headingLevelAt(text: string, point: number): number {
  return markdownHeadingAtPoint(text, point)?.level ?? 1
}

const LINK_RE = /!?\[[^\]]*\]\(([^)]+)\)|<((?:https?:\/\/|mailto:)[^>]+)>/g

function findLink(text: string, point: number, direction: 1 | -1): number | null {
  const matches: Array<{ index: number }> = []
  for (const match of text.matchAll(LINK_RE)) {
    if (match.index != null) matches.push({ index: match.index })
  }
  if (direction === 1) {
    for (const m of matches) if (m.index > point) return m.index
    return null
  }
  let prev: number | null = null
  for (const m of matches) {
    if (m.index >= point) break
    prev = m.index
  }
  return prev
}

function linkUrlAtPoint(text: string, point: number): string | null {
  for (const match of text.matchAll(LINK_RE)) {
    if (match.index == null) continue
    const end = match.index + match[0].length
    if (point >= match.index && point <= end) return match[1] ?? match[2] ?? null
  }
  return null
}

const SAFE_URL_SCHEME = /^(https?|mailto):/i

function spawnUrl(url: string): void {
  // The url comes from markdown link text — refuse anything that isn't a
  // browser-safe scheme so `[x](--flag)` or `[x](file:///etc/passwd)` can't
  // reach the OS opener, and `--` stops it being parsed as an option.
  let scheme: string
  try { scheme = new URL(url).protocol } catch { return }
  if (!SAFE_URL_SCHEME.test(scheme)) return
  const platform = process.platform
  const cmd = platform === "darwin" ? ["open", "--", url]
    : platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url]
    : ["xdg-open", "--", url]
  void import("../../src/platform/runtime").then(({ spawnProcess }) => {
    try { spawnProcess({ cmd }) } catch { /* best effort */ }
  })
}

function isBlankLine(text: string, offset: number): boolean {
  const start = offset <= 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1
  const end = lineEnd(text, start)
  return text.slice(start, end).trim() === ""
}

function previousLineStart(text: string, lineStart: number): number | null {
  if (lineStart <= 0) return null
  return text.lastIndexOf("\n", lineStart - 2) + 1
}

function nextLineStart(text: string, offset: number): number {
  const end = lineEnd(text, offset)
  return end >= text.length ? text.length : end + 1
}

function lineEnd(text: string, start: number): number {
  const end = text.indexOf("\n", start)
  return end === -1 ? text.length : end
}

function lineIndent(text: string, lineStart: number): number {
  const line = text.slice(lineStart, lineEnd(text, lineStart))
  return line.match(/^\s*/)?.[0].length ?? 0
}
