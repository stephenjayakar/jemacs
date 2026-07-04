import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import type { FaceName, FontLockRange, TextSpan } from "../../src/modes/mode"
import { defineMode, enterMode } from "../../src/modes/mode"
import { Keymap } from "../../src/kernel/keymap"

export const ORG_FOLDED_LOCAL = "org-folded"

// Spec: /^(\*+) (TODO|DONE)? ?(.*)/ — stars, optional keyword, headline text.
const HEADLINE_RE = /^(\*+) (TODO|DONE)? ?(.*)$/
const TODO_CYCLE = ["TODO", "DONE", null] as const
const ORG_TABLE_SEPARATOR_RE = /^\s*\|[-+]+\|\s*$/
const SAFE_URL_SCHEME = /^(https?|mailto):/i

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

type OrgEditResult = { changed: boolean; message: string }
type OrgTableCell = { text: string; start: number; end: number }
type OrgTableRow = { line: number; raw: string; cells: OrgTableCell[]; separator: boolean }
type OrgTable = { startLine: number; endLine: number; startOffset: number; indent: string; rows: OrgTableRow[] }
type OrgLink = { start: number; end: number; target: string; description: string | null; targetStart: number }

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

function orgTableLine(line: string): boolean {
  return /^\s*\|/.test(line)
}

function splitOrgTableCells(line: string, separator = ORG_TABLE_SEPARATOR_RE.test(line)): OrgTableCell[] {
  const indentLen = line.match(/^\s*/)?.[0].length ?? 0
  let start = indentLen
  let end = line.length
  if (line[start] === "|") start++
  while (end > start && /\s/.test(line[end - 1]!)) end--
  if (end > start && line[end - 1] === "|") end--

  const cells: OrgTableCell[] = []
  const delimiter = separator ? "+" : "|"
  let cellStart = start
  for (let i = start; i <= end; i++) {
    if (i === end || line[i] === delimiter) {
      const raw = line.slice(cellStart, i)
      const left = raw.match(/^\s*/)?.[0].length ?? 0
      const right = raw.match(/\s*$/)?.[0].length ?? 0
      const empty = raw.trim().length === 0
      cells.push({
        text: raw.trim(),
        start: empty ? Math.min(cellStart + 1, i) : cellStart + left,
        end: empty ? Math.min(cellStart + 1, i) : i - right,
      })
      cellStart = i + 1
    }
  }
  return cells
}

function orgTableAtPoint(text: string, point: number): OrgTable | null {
  const lines = text.split("\n")
  const line = text.slice(0, point).split("\n").length - 1
  if (!orgTableLine(lines[line] ?? "")) return null

  let startLine = line
  while (startLine > 0 && orgTableLine(lines[startLine - 1] ?? "")) startLine--
  let endLine = line
  while (endLine + 1 < lines.length && orgTableLine(lines[endLine + 1] ?? "")) endLine++

  const indent = lines[startLine]?.match(/^\s*/)?.[0] ?? ""
  const rows = lines.slice(startLine, endLine + 1).map((raw, i) => {
    const separator = ORG_TABLE_SEPARATOR_RE.test(raw)
    return { line: startLine + i, raw, separator, cells: splitOrgTableCells(raw, separator) }
  })
  if (!rows.length || rows.some(row => row.cells.length === 0)) return null
  return { startLine, endLine, startOffset: lineStartAt(text, startLine), indent, rows }
}

function normalizedOrgTableRows(table: OrgTable, rows = table.rows): string[] {
  const columnCount = Math.max(1, ...rows.map(row => row.cells.length))
  const widths = Array.from({ length: columnCount }, (_, col) =>
    Math.max(1, ...rows.filter(row => !row.separator).map(row => row.cells[col]?.text.length ?? 0)))

  return rows.map(row => {
    if (row.separator) return `${table.indent}|${widths.map(width => "-".repeat(width + 2)).join("+")}|`
    const parts = widths.map((width, col) => {
      const text = row.cells[col]?.text ?? ""
      return ` ${text}${" ".repeat(width - text.length)} `
    })
    return `${table.indent}|${parts.join("|")}|`
  })
}

function tableLineStart(table: OrgTable, line: number): number {
  const prefixRows = table.rows.slice(0, Math.max(0, line - table.startLine))
  return table.startOffset + prefixRows.reduce((sum, row) => sum + row.raw.length + 1, 0)
}

function currentOrgTableCell(table: OrgTable, point: number): { rowIndex: number; colIndex: number } | null {
  const rowIndex = table.rows.findIndex(row => {
    const start = tableLineStart(table, row.line)
    return point >= start && point <= start + row.raw.length
  })
  if (rowIndex < 0) return null
  const row = table.rows[rowIndex]!
  const lineStart = tableLineStart(table, row.line)
  const col = point - lineStart
  const idx = row.cells.findIndex(cell => col <= cell.end)
  return { rowIndex, colIndex: idx < 0 ? Math.max(0, row.cells.length - 1) : idx }
}

function makeOrgTableRow(table: OrgTable, rowIndex: number, cells: string[], separator = false): OrgTableRow {
  return {
    line: table.startLine + rowIndex,
    raw: "",
    separator,
    cells: cells.map(text => ({ text, start: 0, end: text.length })),
  }
}

function renumberOrgTableRows(table: OrgTable, rows: OrgTableRow[]): OrgTableRow[] {
  return rows.map((row, i) => ({ ...row, line: table.startLine + i }))
}

function replaceOrgTable(buffer: BufferModel, table: OrgTable, rows: OrgTableRow[], pointCell?: { row: number; col: number }): OrgTable | null {
  const replacement = normalizedOrgTableRows(table, rows)
  replaceLines(buffer, table.startLine, table.endLine, replacement)
  if (pointCell) {
    const line = Math.min(table.startLine + pointCell.row, table.startLine + replacement.length - 1)
    const row = splitOrgTableCells(replacement[line - table.startLine] ?? "")
    const cell = row[Math.min(pointCell.col, Math.max(0, row.length - 1))]
    buffer.point = lineStartAt(buffer.text, line) + (cell?.start ?? table.indent.length + 2)
  } else {
    buffer.point = Math.min(buffer.point, buffer.text.length)
  }
  return orgTableAtPoint(buffer.text, buffer.point)
}

function orgTableAlign(buffer: BufferModel): OrgEditResult {
  const table = orgTableAtPoint(buffer.text, buffer.point)
  if (!table) return { changed: false, message: "No table at point" }
  const current = currentOrgTableCell(table, buffer.point)
  replaceOrgTable(buffer, table, table.rows, current ? { row: current.rowIndex, col: current.colIndex } : undefined)
  return { changed: true, message: "Aligned table" }
}

function orgTableForwardCell(buffer: BufferModel): OrgEditResult {
  const aligned = orgTableAlign(buffer)
  if (!aligned.changed) return aligned
  let table = orgTableAtPoint(buffer.text, buffer.point)
  if (!table) return { changed: false, message: "No table at point" }
  const current = currentOrgTableCell(table, buffer.point)
  if (!current) return { changed: false, message: "No table cell at point" }
  const columns = Math.max(1, ...table.rows.map(row => row.cells.length))

  for (let row = current.rowIndex; row < table.rows.length; row++) {
    const rowInfo = table.rows[row]!
    if (rowInfo.separator) continue
    const startCol = row === current.rowIndex ? current.colIndex + 1 : 0
    if (startCol < columns) {
      replaceOrgTable(buffer, table, table.rows, { row, col: startCol })
      return { changed: true, message: "Moved to next table cell" }
    }
  }

  const insertAt = table.rows.length
  const empty = makeOrgTableRow(table, insertAt, Array.from({ length: columns }, () => ""))
  table = replaceOrgTable(buffer, table, renumberOrgTableRows(table, [...table.rows, empty]), { row: insertAt, col: 0 }) ?? table
  return { changed: true, message: "Inserted table row" }
}

function orgTableBackwardCell(buffer: BufferModel): OrgEditResult {
  const aligned = orgTableAlign(buffer)
  if (!aligned.changed) return aligned
  const table = orgTableAtPoint(buffer.text, buffer.point)
  if (!table) return { changed: false, message: "No table at point" }
  const current = currentOrgTableCell(table, buffer.point)
  if (!current) return { changed: false, message: "No table cell at point" }
  const columns = Math.max(1, ...table.rows.map(row => row.cells.length))

  for (let row = current.rowIndex; row >= 0; row--) {
    const rowInfo = table.rows[row]!
    if (rowInfo.separator) continue
    const startCol = row === current.rowIndex ? current.colIndex - 1 : columns - 1
    if (startCol >= 0) {
      replaceOrgTable(buffer, table, table.rows, { row, col: startCol })
      return { changed: true, message: "Moved to previous table cell" }
    }
  }
  return { changed: false, message: "No previous table cell" }
}

function orgTableNextRow(buffer: BufferModel): OrgEditResult {
  const aligned = orgTableAlign(buffer)
  if (!aligned.changed) return aligned
  const table = orgTableAtPoint(buffer.text, buffer.point)
  if (!table) return { changed: false, message: "No table at point" }
  const current = currentOrgTableCell(table, buffer.point)
  if (!current) return { changed: false, message: "No table cell at point" }
  const columns = Math.max(1, ...table.rows.map(row => row.cells.length))

  for (let row = current.rowIndex + 1; row < table.rows.length; row++) {
    if (!table.rows[row]!.separator) {
      replaceOrgTable(buffer, table, table.rows, { row, col: current.colIndex })
      return { changed: true, message: "Moved to table row" }
    }
  }

  const insertAt = table.rows.length
  const empty = makeOrgTableRow(table, insertAt, Array.from({ length: columns }, () => ""))
  replaceOrgTable(buffer, table, renumberOrgTableRows(table, [...table.rows, empty]), { row: insertAt, col: Math.min(current.colIndex, columns - 1) })
  return { changed: true, message: "Inserted table row" }
}

function orgTableCreateOrConvertFromRegion(buffer: BufferModel): OrgEditResult {
  if (buffer.mark == null || buffer.mark === buffer.point) {
    const line = buffer.lineBoundsAt()
    const text = "|   |   |\n|---+---|\n|   |   |"
    buffer.replaceRange(line.start, line.text.trim() ? line.start : line.end, line.text.trim() ? `${text}\n` : text)
    buffer.point = line.start + 2
    return { changed: true, message: "Inserted table" }
  }

  const start = Math.min(buffer.mark, buffer.point)
  const end = Math.max(buffer.mark, buffer.point)
  const startLine = buffer.lineAt(start)
  const endLine = buffer.lineAt(Math.max(start, end - 1))
  const lines = buffer.text.split("\n").slice(startLine, endLine + 1)
  const rawRows = lines.map(line => line.trim().split(/[ \t]+/).filter(Boolean))
  const columns = Math.max(1, ...rawRows.map(row => row.length))
  const table: OrgTable = {
    startLine,
    endLine,
    startOffset: lineStartAt(buffer.text, startLine),
    indent: lines[0]?.match(/^\s*/)?.[0] ?? "",
    rows: rawRows.map((cells, i) => makeOrgTableRow({ startLine, endLine, startOffset: 0, indent: "", rows: [] }, i, [...cells, ...Array.from({ length: columns - cells.length }, () => "")])),
  }
  replaceLines(buffer, startLine, endLine, normalizedOrgTableRows(table))
  buffer.point = lineStartAt(buffer.text, startLine) + table.indent.length + 2
  return { changed: true, message: "Converted region to table" }
}

function orgLinks(text: string): OrgLink[] {
  const links: OrgLink[] = []
  const re = /\[\[([^\]\n]+)\](?:\[([^\]\n]*)\])?\]/g
  for (let match; (match = re.exec(text));) {
    links.push({
      start: match.index,
      end: match.index + match[0]!.length,
      target: match[1]!,
      description: match[2] ?? null,
      targetStart: match.index + 2,
    })
  }
  return links
}

function orgLinkAtPoint(text: string, point: number): OrgLink | null {
  return orgLinks(text).find(link => point >= link.start && point <= link.end) ?? null
}

function findOrgLink(text: string, point: number, dir: 1 | -1): number | null {
  const links = orgLinks(text)
  const link = dir === 1
    ? links.find(l => l.start > point)
    : [...links].reverse().find(l => l.start < point)
  return link?.start ?? null
}

function insertOrgLink(buffer: BufferModel, target: string, description: string | null): void {
  buffer.insert(description ? `[[${target}][${description}]]` : `[[${target}]]`)
}

function spawnUrl(url: string): void {
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

function jumpToInternalLink(buffer: BufferModel, target: string): boolean {
  if (!target.startsWith("*")) return false
  const title = target.replace(/^\*+\s*/, "")
  const heading = orgParseHeadlines(buffer.text).find(h => h.title === title || `${"*".repeat(h.level)} ${h.title}` === target)
  if (!heading) return false
  buffer.point = heading.start
  return true
}

function checkboxAtPoint(buffer: BufferModel): { start: number; end: number; checked: boolean } | null {
  const line = buffer.lineBoundsAt()
  const match = /^(\s*[-+*]\s+)\[([ Xx])\]/.exec(line.text)
  if (!match) return null
  const start = line.start + match[1]!.length + 1
  return { start, end: start + 1, checked: match[2]!.toUpperCase() === "X" }
}

function parentCookieLine(buffer: BufferModel, fromLine: number): number | null {
  const lines = buffer.text.split("\n")
  for (let line = fromLine - 1; line >= 0; line--) {
    if (/\[(?:\d+\/\d+|\d+%)\]/.test(lines[line] ?? "")) return line
  }
  return null
}

function cookieExtent(buffer: BufferModel, parentLine: number): { startLine: number; endLine: number } {
  const lines = buffer.text.split("\n")
  const parent = lines[parentLine] ?? ""
  const heading = HEADLINE_RE.exec(parent)
  if (heading) {
    const level = heading[1]!.length
    let endLine = lines.length - 1
    for (let line = parentLine + 1; line < lines.length; line++) {
      const h = HEADLINE_RE.exec(lines[line] ?? "")
      if (h && h[1]!.length <= level) { endLine = line - 1; break }
    }
    return { startLine: parentLine + 1, endLine }
  }
  const indent = parent.match(/^\s*/)?.[0].length ?? 0
  let endLine = lines.length - 1
  for (let line = parentLine + 1; line < lines.length; line++) {
    const text = lines[line] ?? ""
    if (!text.trim()) { endLine = line - 1; break }
    const lineIndent = text.match(/^\s*/)?.[0].length ?? 0
    if (lineIndent <= indent && /^[-+*]\s+/.test(text.slice(lineIndent))) { endLine = line - 1; break }
  }
  return { startLine: parentLine + 1, endLine }
}

function updateCheckboxStatistics(buffer: BufferModel, fromLine: number): void {
  const parentLine = parentCookieLine(buffer, fromLine)
  if (parentLine == null) return
  const lines = buffer.text.split("\n")
  const extent = cookieExtent(buffer, parentLine)
  let total = 0
  let checked = 0
  for (let line = extent.startLine; line <= extent.endLine; line++) {
    const match = /^\s*[-+*]\s+\[([ Xx])\]/.exec(lines[line] ?? "")
    if (!match) continue
    total++
    if (match[1]!.toUpperCase() === "X") checked++
  }
  const parent = lines[parentLine] ?? ""
  lines[parentLine] = parent.replace(/\[(\d+)\/(\d+)\]|\[(\d+)%\]/, match =>
    match.includes("/") ? `[${checked}/${total}]` : `[${total === 0 ? 0 : Math.round((checked / total) * 100)}%]`)
  const point = buffer.point
  buffer.replaceRange(0, buffer.text.length, lines.join("\n"))
  buffer.point = Math.min(point, buffer.text.length)
}

function orgToggleCheckbox(buffer: BufferModel): OrgEditResult {
  const checkbox = checkboxAtPoint(buffer)
  if (!checkbox) return { changed: false, message: "No checkbox at point" }
  const line = buffer.lineAt(buffer.point)
  buffer.replaceRange(checkbox.start, checkbox.end, checkbox.checked ? " " : "X")
  updateCheckboxStatistics(buffer, line)
  return { changed: true, message: checkbox.checked ? "Unchecked checkbox" : "Checked checkbox" }
}

export function orgFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  for (const h of orgParseHeadlinesInRange(buffer.text, range)) {
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
  const linkSpans = orgLinks(buffer.text)
    .filter(link => !range || (link.end >= range.start && link.start <= range.end))
    .map(link => ({ start: link.start, end: link.end, face: "markdown-link" as FaceName }))
  return [...spans, ...linkSpans].sort((a, b) => a.start - b.start || a.end - b.end)
}

function orgParseHeadlinesInRange(text: string, range?: FontLockRange): OrgHeadline[] {
  if (!range) return orgParseHeadlines(text)
  const out: OrgHeadline[] = []
  const lines = text.slice(range.start, range.end).split("\n")
  let offset = range.start
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = HEADLINE_RE.exec(line)
    if (m) {
      out.push({
        line: range.startLine + i,
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

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const keymap = new Keymap("org-mode-map")
  keymap.bind("tab", "org-cycle")
  keymap.bind("S-tab", "org-table-previous-field")
  keymap.bind("|", "org-self-insert-pipe")
  keymap.bind("return", "org-return")
  keymap.bind("enter", "org-return")
  keymap.bind("C-m", "org-return")
  keymap.bind("C-c C-c", "org-ctrl-c-ctrl-c")
  keymap.bind("C-c |", "org-table-create-or-convert-from-region")
  keymap.bind("C-c C-l", "org-insert-link")
  keymap.bind("C-c C-o", "org-open-at-point")
  keymap.bind("C-c C-t", "org-todo")
  keymap.bind("M-RET", "org-meta-return")
  keymap.bind("M-left", "org-promote")
  keymap.bind("M-right", "org-demote")
  keymap.bind("C-c C-n", "org-next-visible-heading")
  keymap.bind("C-c C-p", "org-previous-visible-heading")
  keymap.bind("C-c C-x C-n", "org-next-link")
  keymap.bind("C-c C-x C-p", "org-previous-link")

  defineMode({
    name: "org-mode",
    parent: "text",
    commentStart: "#",
    keymap,
    fontLock: orgFontLock,
    displayFilter: orgDisplayFilter,
  })

  editor.command("org-cycle", ({ editor, buffer }) => {
    if (orgTableAtPoint(buffer.text, buffer.point)) {
      const result = orgTableForwardCell(buffer)
      editor.message(result.message)
      return
    }
    const state = cycle(buffer)
    if (state == null) editor.message("Not at a heading")
    else editor.message(state.toUpperCase())
  }, "TAB on a headline: cycle visibility folded → children → subtree.")

  editor.command("org-table-previous-field", ({ editor, buffer }) => {
    const result = orgTableBackwardCell(buffer)
    editor.message(result.message)
  }, "Move to previous Org table field.")

  editor.command("org-self-insert-pipe", ({ editor, buffer }) => {
    buffer.insert("|")
    const result = orgTableAtPoint(buffer.text, buffer.point) ? orgTableAlign(buffer) : null
    if (result) editor.message(result.message)
  }, "Insert `|' and realign an Org table when inside one.")

  editor.command("org-return", async ({ editor, buffer }) => {
    if (orgTableAtPoint(buffer.text, buffer.point)) {
      const result = orgTableNextRow(buffer)
      editor.message(result.message)
      return
    }
    await editor.run("newline")
  }, "RET in Org: move down in tables, otherwise insert a newline.")

  editor.command("org-table-align", ({ editor, buffer }) => {
    const result = orgTableAlign(buffer)
    editor.message(result.message)
  }, "Align the Org table at point.")

  editor.command("org-table-create-or-convert-from-region", ({ editor, buffer }) => {
    const result = orgTableCreateOrConvertFromRegion(buffer)
    editor.message(result.message)
  }, "Create an Org table or convert the active region to a table.")

  editor.command("org-insert-link", async ({ editor, buffer }) => {
    const target = await editor.prompt("Link: ", "", "org-link-target")
    if (target == null) return
    const description = await editor.prompt("Description: ", "", "org-link-description")
    insertOrgLink(buffer, target, description && description.length ? description : null)
  }, "Insert an Org link.")

  editor.command("org-open-at-point", ({ editor, buffer }) => {
    const link = orgLinkAtPoint(buffer.text, buffer.point)
    if (!link) { editor.message("No link at point"); return }
    if (/^https?:/i.test(link.target)) {
      spawnUrl(link.target)
      editor.message(`Opened ${link.target}`)
      return
    }
    if (jumpToInternalLink(buffer, link.target)) {
      editor.message(`Followed ${link.target}`)
      return
    }
    editor.message("Cannot open link")
  }, "Open the Org link at point.")

  editor.command("org-next-link", ({ editor, buffer }) => {
    const next = findOrgLink(buffer.text, buffer.point, 1)
    if (next == null) { editor.message("No next link"); return }
    buffer.point = next
  }, "Move to the next Org link.")

  editor.command("org-previous-link", ({ editor, buffer }) => {
    const prev = findOrgLink(buffer.text, buffer.point, -1)
    if (prev == null) { editor.message("No previous link"); return }
    buffer.point = prev
  }, "Move to the previous Org link.")

  editor.command("org-toggle-checkbox", ({ editor, buffer }) => {
    const result = orgToggleCheckbox(buffer)
    editor.message(result.message)
  }, "Toggle the checkbox at point.")

  editor.command("org-ctrl-c-ctrl-c", ({ editor, buffer }) => {
    const table = orgTableAtPoint(buffer.text, buffer.point)
    if (table) {
      const result = orgTableAlign(buffer)
      editor.message(result.message)
      return
    }
    if (checkboxAtPoint(buffer)) {
      const result = orgToggleCheckbox(buffer)
      editor.message(result.message)
      return
    }
    editor.message("C-c C-c has no effect here")
  }, "Org context command: align tables, toggle checkboxes, or report no action.")

  editor.command("org-todo", ({ buffer }) => todoCycle(buffer),
    "Cycle the TODO keyword of the current heading: TODO → DONE → (none).")

  editor.command("org-meta-return", ({ buffer }) => insertSibling(buffer),
    "Insert a new sibling heading after the current subtree.")

  editor.command("org-promote", ({ buffer }) => shiftLevel(buffer, -1),
    "Decrease the level of the current heading by one.")
  editor.command("org-demote", ({ buffer }) => shiftLevel(buffer, +1),
    "Increase the level of the current heading by one.")

  editor.command("org-next-visible-heading", ({ editor, buffer }) => {
    if (!gotoHeading(buffer, 1)) editor.message("No next heading")
  }, "Move to the next heading.")
  editor.command("org-previous-visible-heading", ({ editor, buffer }) => {
    if (!gotoHeading(buffer, -1)) editor.message("No previous heading")
  }, "Move to the previous heading.")

  editor.command("org-mode", ({ editor, buffer }) => editor.enterMode(buffer, "org-mode"),
    "Major mode for editing Org files.")

  // inferMode() doesn't know .org; pick it up at find-file time instead.
  ctx.hook("find-file-hook", ({ buffer }) => {
    if (buffer.path && /\.org$/i.test(buffer.path)) enterMode(buffer, "org-mode")
  })
}
