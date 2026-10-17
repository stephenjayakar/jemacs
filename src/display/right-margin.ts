import type { BufferModel } from "../kernel/buffer"
import type { FaceName } from "../modes/mode"
import { defvar, getCustom } from "../runtime/custom"
import { mergeFaceStyles } from "../runtime/faces"
import { resolveFace } from "./face-resolve"
import type { FaceStyle, Theme } from "./theme"
import { sameChunkStyle, styleToChunk, type ThemedChunk, type ThemedText } from "./themed-text"

/** A note pinned to buffer offset `pos`, drawn in the window's right margin
 *  beside the row that shows `pos`. Notes that collide stack downward.
 *
 *  With an `id`, the note is clickable: clicking its text reports the `edit`
 *  action, and `actions: true` adds `√` (`resolve`) and `+` (`reply`) buttons.
 *  Clicks go to `right-margin-click-functions`. `spans` lay extra faces over
 *  parts of `text` (offsets into `text`), e.g. rendered markdown emphasis. */
export type RightMarginNote = { pos: number; text: string; face?: string; spans?: RightMarginSpan[]; id?: string; actions?: boolean }
export type RightMarginSpan = { start: number; end: number; face: string }
export type RightMarginSpec = { width: number; notes: RightMarginNote[] }
/** `point` is the window's point (not necessarily `buffer.point` for an
 *  unselected window). Return null to draw nothing. */
export type RightMarginFn = (buffer: BufferModel, point: number) => RightMarginSpec | null
export type RightMarginAction = "edit" | "resolve" | "reply"
/** Return true when the click was handled. */
export type RightMarginClickFn = (buffer: BufferModel, note: string, action: RightMarginAction) => boolean
/** A clickable margin cell range on body row `row`, columns [start, end). For
 *  char-grid hosts, whose clicks arrive as cells; DOM hosts read the chunk's
 *  `marginNote`/`marginAction` instead. */
export type RightMarginHit = { row: number; start: number; end: number; note: string; action: RightMarginAction }

/** Which logical row (offset from the window's start line) a body row shows,
 *  and whether it is that row's first wrapped segment. */
export type RowOrigin = { row: number; first: boolean }

/** Viewport-independent margin: notes resolved to display-text line indices. */
export type LogicalRightMargin = {
  width: number
  notes: Array<{ line: number; text: string; face?: string; spans?: RightMarginSpan[]; id?: string; actions?: boolean }>
}

defvar("right-margin-functions", [] as RightMarginFn[],
  "Functions returning right-margin notes for a buffer (see `RightMarginSpec`).")
defvar("right-margin-click-functions", [] as RightMarginClickFn[],
  "Functions called with (buffer, note-id, action) when a clickable margin note is clicked.")

const ACTIONS: Array<{ action: RightMarginAction; label: string }> = [
  { action: "resolve", label: " √" },
  { action: "reply", label: " +" },
]
const ACTIONS_COLS = ACTIONS.reduce((n, a) => n + a.label.length, 0)

/** `pane-action` name DOM hosts send for a margin click (payload: note, action). */
export const RIGHT_MARGIN_CLICK = "right-margin-click"

/** Offer a margin click to `right-margin-click-functions`; true if one took it. */
export function rightMarginClick(buffer: BufferModel, note: string, action: string): boolean {
  if (action !== "edit" && action !== "resolve" && action !== "reply") return false
  for (const fn of getCustom<RightMarginClickFn[]>("right-margin-click-functions") ?? []) {
    try {
      if (fn(buffer, note, action)) return true
    } catch (err) {
      console.error("right-margin click function threw:", err)
    }
  }
  return false
}

/** Narrowest text column we keep before dropping the margin entirely. */
const MIN_TEXT_COLS = 40
/** " │ " + "• " */
const NOTE_PREFIX_COLS = 5

/** Collect `right-margin-functions` for `buffer` and map note offsets into
 *  display-text lines. Each function is guarded so one bad plugin can't take
 *  the frame down. */
export function logicalRightMargin(
  buffer: BufferModel,
  point: number,
  displayText: string,
  displayMap?: (n: number) => number,
): LogicalRightMargin | undefined {
  const fns = getCustom<RightMarginFn[]>("right-margin-functions") ?? []
  if (!fns.length) return undefined
  let width = 0
  const raw: RightMarginNote[] = []
  for (const fn of fns) {
    let spec: RightMarginSpec | null
    try { spec = fn(buffer, point) } catch (err) {
      console.error("right-margin function threw:", err)
      continue
    }
    if (!spec) continue
    width = Math.max(width, spec.width)
    raw.push(...spec.notes)
  }
  if (!raw.length || width <= NOTE_PREFIX_COLS) return undefined
  const placed = raw
    .map(note => ({ note, dpos: displayMap ? displayMap(note.pos) : note.pos }))
    .sort((a, b) => a.dpos - b.dpos)
  const notes: LogicalRightMargin["notes"] = []
  let line = 0
  let scan = 0
  for (const { note, dpos } of placed) {
    const limit = Math.min(dpos, displayText.length)
    for (; scan < limit; scan++) if (displayText.charCodeAt(scan) === 10) line++
    notes.push({ line, text: note.text, face: note.face, spans: note.spans, id: note.id, actions: note.actions })
  }
  return { width: Math.floor(width), notes }
}

/** Clamp the requested margin to the window; null when the window is too
 *  narrow to spare it. */
export function fitRightMargin(margin: LogicalRightMargin | undefined, cols: number | undefined): LogicalRightMargin | null {
  if (!margin || cols == null) return null
  const width = Math.min(margin.width, Math.floor(cols * 0.4))
  if (width <= NOTE_PREFIX_COLS || cols - width < MIN_TEXT_COLS) return null
  return { ...margin, width }
}

/** Append margin cells to each body row. `origins[k]` says which logical row
 *  (offset from `startLine`) body row `k` belongs to; notes start on the first
 *  wrapped row of their line and push later notes down when they overlap.
 *  Margin chunks are tagged so DOM hosts can position them independently of
 *  variable-pitch text; `hits` locates the clickable cells for char-grid hosts. */
export function appendRightMargin(
  body: ThemedText,
  origins: readonly RowOrigin[],
  startLine: number,
  margin: LogicalRightMargin,
  textCols: number,
  theme: Theme,
  buffer?: BufferModel,
): { text: ThemedText; hits: RightMarginHit[] } {
  const byLine = new Map<number, LogicalRightMargin["notes"]>()
  for (const note of margin.notes) {
    const list = byLine.get(note.line)
    if (list) list.push(note)
    else byLine.set(note.line, [note])
  }
  const textWidth = margin.width - NOTE_PREFIX_COLS
  type QueuedLine = { bullet: boolean; pieces: StyledPiece[]; style: Omit<ThemedChunk, "text">; id?: string; actions: boolean }
  const queue: QueuedLine[] = []
  const rows = splitRows(body)
  const out: ThemedChunk[] = []
  const hits: RightMarginHit[] = []
  for (let k = 0; k < rows.length; k++) {
    if (k > 0) out.push({ text: "\n" })
    const row = rows[k]!
    out.push(...row)
    const origin = origins[k]
    if (origin?.first) {
      for (const note of byLine.get(startLine + origin.row) ?? []) {
        const base = resolveFace((note.face ?? "comment") as FaceName, theme, buffer)
        const style = styleToChunk(base)
        const actions = Boolean(note.id && note.actions && textWidth - ACTIONS_COLS > 4)
        const text = note.text || "(empty)"
        const spans = note.text ? note.spans ?? [] : []
        wrapWordRanges(text, textWidth, actions ? textWidth - ACTIONS_COLS : textWidth)
          .forEach((words, i) => queue.push({
            bullet: i === 0,
            pieces: styleLine(text, words, spans, base, theme, buffer),
            style,
            id: note.id,
            actions: actions && i === 0,
          }))
      }
    }
    const next = queue.shift()
    if (!next) continue
    const used = row.reduce((n, c) => n + cellWidth(c.text), 0)
    if (used < textCols) out.push({ text: " ".repeat(textCols - used), marginPad: true })
    let col = Math.max(used, textCols)
    const push = (text: string, action: RightMarginAction, style = next.style) => {
      const target = next.id ? { marginNote: next.id, marginAction: action } : {}
      out.push({ ...style, text, margin: true, ...target })
      if (next.id) hits.push({ row: k, start: col, end: col + text.length, note: next.id, action })
      col += text.length
    }
    // Pad to the full margin width so DOM hosts (which pin the note) keep
    // every row's bar in the same column.
    const bodyCols = margin.width - (next.actions ? ACTIONS_COLS : 0)
    const pieces = mergePieces([
      { text: ` │ ${next.bullet ? "•" : " "} `, style: next.style },
      ...next.pieces,
    ])
    const noteCols = pieces.reduce((n, p) => n + p.text.length, 0)
    if (noteCols < bodyCols) pieces.push(...mergePieces([pieces.pop()!, { text: " ".repeat(bodyCols - noteCols), style: next.style }]))
    for (const piece of pieces) push(piece.text, "edit", piece.style)
    if (next.actions) for (const { action, label } of ACTIONS) push(label, action)
  }
  return { text: { chunks: out }, hits }
}

function splitRows(body: ThemedText): ThemedChunk[][] {
  const rows: ThemedChunk[][] = [[]]
  for (const chunk of body.chunks) {
    const parts = chunk.text.split("\n")
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) rows.push([])
      if (parts[i]) rows[rows.length - 1]!.push({ ...chunk, text: parts[i]! })
    }
  }
  return rows
}

function cellWidth(text: string): number {
  let n = 0
  for (const _ of text) n++
  return n
}

type StyledPiece = { text: string; style: Omit<ThemedChunk, "text"> }

/** Greedy word wrap; words longer than the line are hard-split. The first
 *  line may be narrower (`firstWidth`) to leave room for action buttons. */
export function wrapWords(text: string, width: number, firstWidth = width): string[] {
  return wrapWordRanges(text, width, firstWidth)
    .map(words => words.map(([start, end]) => text.slice(start, end)).join(" "))
}

/** `wrapWords`, but each line is the [start, end) offsets of its words in
 *  `text`, so styles keyed to `text` survive the wrap. Words on one line are
 *  joined by a single space. */
function wrapWordRanges(text: string, width: number, firstWidth: number): Array<Array<[number, number]>> {
  const lines: Array<Array<[number, number]>> = []
  let line: Array<[number, number]> = []
  let len = 0
  const cap = () => (lines.length ? width : firstWidth)
  for (const match of text.matchAll(/\S+/g)) {
    let start = match.index!
    const end = start + match[0].length
    for (;;) {
      const c = cap()
      if (!line.length) {
        if (end - start <= c) { line = [[start, end]]; len = end - start; break }
        lines.push([[start, start + c]])
        start += c
        continue
      }
      if (len + 1 + end - start <= c) { line.push([start, end]); len += 1 + end - start; break }
      lines.push(line)
      line = []
    }
  }
  if (line.length) lines.push(line)
  return lines.length ? lines : [[]]
}

/** Render one wrapped line: each character takes the note face with every
 *  span covering it layered on top. The space between two words is styled
 *  like the whitespace it stands for, so `**two words**` stays one run. */
function styleLine(
  text: string,
  words: Array<[number, number]>,
  spans: readonly RightMarginSpan[],
  base: FaceStyle | undefined,
  theme: Theme,
  buffer: BufferModel | undefined,
): StyledPiece[] {
  const baseChunk = styleToChunk(base)
  if (!spans.length) {
    return [{ text: words.map(([s, e]) => text.slice(s, e)).join(" "), style: baseChunk }]
  }
  const styleAt = (i: number): Omit<ThemedChunk, "text"> => {
    let style = base
    for (const span of spans) {
      if (span.start <= i && i < span.end) style = mergeFaceStyles(style, marginOverlay(resolveFace(span.face as FaceName, theme, buffer)))
    }
    return style === base ? baseChunk : styleToChunk(style)
  }
  const pieces: StyledPiece[] = []
  words.forEach(([start, end], w) => {
    if (w > 0) pieces.push({ text: " ", style: styleAt(words[w - 1]![1]) })
    for (let i = start; i < end; i++) pieces.push({ text: text[i]!, style: styleAt(i) })
  })
  return mergePieces(pieces)
}

/** A span face may recolour or embolden, but the margin is a fixed-pitch
 *  column on the row's line: drop font family and size, which would break
 *  the alignment. */
function marginOverlay(style: FaceStyle | undefined): FaceStyle | undefined {
  if (!style) return undefined
  const { family: _family, height: _height, heightScale: _scale, ...rest } = style
  return rest
}

function mergePieces(pieces: StyledPiece[]): StyledPiece[] {
  const out: StyledPiece[] = []
  for (const piece of pieces) {
    const last = out[out.length - 1]
    if (last && sameChunkStyle(last.style, piece.style)) last.text += piece.text
    else if (piece.text) out.push({ ...piece })
  }
  return out
}
