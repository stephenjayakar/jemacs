import type { BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { addHook } from "../../src/kernel/hooks"
import { Keymap } from "../../src/kernel/keymap"
import { defcustom } from "../../src/runtime/custom"
import { defface, faceRemapAddRelative } from "../../src/runtime/faces"
import { defineMode, enterMode, type FaceName, type TextSpan } from "../../src/modes/mode"
import { treeSitterFontLock } from "../../src/modes/tree-sitter"

const TAB_WIDTH = 4
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+/
const ATX_HEADER_RE = /^(#{1,6})\s/
const BLOCKQUOTE_RE = /^(\s*)>+\s?/
const FENCED_CODE_RE = /^```/
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
defcustom("markdown-fontify-code-blocks-natively", "boolean", true, "Fontify fenced code blocks with their language mode.")
defcustom("markdown-display-inline-images", "boolean", true, "Replace image links with inline placeholders in the display layer.")
defcustom("markdown-display-remote-images", "boolean", true, "Allow remote image URLs in inline image display.")

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

export type FoldRange = [number, number]
type SubtreeCycle = "folded" | "children" | "subtree"
type GlobalCycle = 1 | 2 | 3
type DisplayFilterResult = { text: string; map: (n: number) => number }
type DisplayFilterCache = { text: string; ranges: FoldRange[]; result: DisplayFilterResult }

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
  return (buffer.locals.get(MARKDOWN_FOLDED_LOCAL) as FoldRange[] | undefined) ?? []
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

export function markdownDisplayFilter(buffer: BufferModel): DisplayFilterResult | null {
  const ranges = foldedRanges(buffer)
  if (!ranges.length) return null
  const src = buffer.text
  const cached = buffer.locals.get(MARKDOWN_FILTER_CACHE) as DisplayFilterCache | undefined
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
  buffer.locals.set(MARKDOWN_FILTER_CACHE, { text: src, ranges, result } satisfies DisplayFilterCache)
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

function overlayMarkdownHeaderFaces(text: string, spans: TextSpan[]): TextSpan[] {
  const headings = markdownParseHeadings(text)
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

function markdownFontLock(buffer: BufferModel): TextSpan[] {
  const lang = buffer.mode === "gfm" ? "gfm" : "markdown"
  return overlayMarkdownHeaderFaces(buffer.text, treeSitterFontLock(lang, buffer))
}

function applyMarkdownFaceRemap(buffer: BufferModel): void {
  faceRemapAddRelative(buffer, "default", { family: "Helvetica Neue", height: 200 })
  for (const [face, scale] of MARKDOWN_HEADER_FACES) {
    faceRemapAddRelative(buffer, face, { heightScale: scale })
  }
  buffer.minorModes.delete("linum-mode")
  buffer.locals.set(MARKDOWN_FILL_COLUMN, 100)
  buffer.locals.set(MARKDOWN_VISUAL_FILL, true)
  buffer.locals.set("word-wrap", true)
  buffer.locals.set("adaptive-wrap-prefix-mode", true)
}

function bindMarkdownModeMap(keymap: Keymap): void {
  keymap.bind("return", "clear-whitespace-and-newline-and-indent")
  keymap.bind("enter", "clear-whitespace-and-newline-and-indent")
  keymap.bind("C-m", "clear-whitespace-and-newline-and-indent")
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
  keymap.bind("C-c C-n", "markdown-outline-next")
  keymap.bind("C-c C-p", "markdown-outline-previous")
  keymap.bind("C-c C-f", "markdown-outline-next-same-level")
  keymap.bind("C-c C-b", "markdown-outline-previous-same-level")
  keymap.bind("C-c C-u", "markdown-outline-up")
  keymap.bind("C-c C-j", "markdown-insert-list-item")
  keymap.bind("M-RET", "markdown-insert-list-item")
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

  editor.command("clear-whitespace-and-newline-and-indent", async ({ editor, buffer }) => {
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

  editor.command("markdown-outdent-or-delete", ({ buffer }) => {
    if (buffer.deleteActiveRegion()) return
    const line = buffer.lineBoundsAt()
    const content = line.text.replace(/^\s*/, "")
    if (content.length === 0 && line.text.length > 0) {
      markdownOutdentLine(buffer)
      return
    }
    if (buffer.point > line.start) buffer.deleteBackward()
  }, "Outdent when only whitespace precedes point, else delete backward.")

  editor.command("markdown-indent-region", ({ buffer }) => {
    const region = regionBounds(buffer)
    indentRegion(buffer, region.start, region.end, TAB_WIDTH)
  }, "Indent the active region.")

  editor.command("markdown-outdent-region", ({ buffer }) => {
    const region = regionBounds(buffer)
    indentRegion(buffer, region.start, region.end, -TAB_WIDTH)
  }, "Outdent the active region.")

  editor.command("markdown-insert-link", ({ buffer, editor }) => {
    wrapOrInsert(buffer, "[", "](url)", "link text")
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
    const line = buffer.lineBoundsAt()
    const match = line.text.match(LIST_RE)
    const indent = match?.[1] ?? ""
    const marker = match?.[2]?.match(/^\d/) ? "1. " : "- "
    buffer.insert(`\n${indent}${marker}`)
    editor.message("Inserted list item")
  }, "Start a new list item on the next line.")

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
    changeHeaderLevel(buffer, -1)
    editor.message("Promoted heading")
  }, "Promote the heading at point.")

  editor.command("markdown-demote", ({ buffer, editor }) => {
    changeHeaderLevel(buffer, 1)
    editor.message("Demoted heading")
  }, "Demote the heading at point.")

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
  installMarkdownCommands(editor)

  for (const [name] of MARKDOWN_HEADER_FACES) defface(name, {}, "Markdown ATX/setext header face.")
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
