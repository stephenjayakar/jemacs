import type { Editor } from "../kernel/editor"
import { textScaleFactor, textScaleLighter } from "../core/text-scale"
import { isearchLazyHighlightSpans, isearchMatchSpan } from "../kernel/isearch"
import { findWindowLeaf, type WindowLeaf, type WindowNode } from "../kernel/window"
import { diagnosticsForBuffer } from "../lsp/diagnostics"
import { positionToPoint } from "../lsp/positions"
import { modeFeature } from "../modes/mode"
import { textWithCursor } from "../ui/text-display"
import { windowClickState } from "./click-to-point"
import { visibleStyledTextFromStart } from "./buffer-view"
import type { DisplayModel, WindowDisplayNode } from "./protocol"
import { bufferHighlightSpans } from "./buffer-highlights"
import { applyTheme } from "./theme"
import { plainThemedText, type ThemedChunk, type ThemedText } from "./themed-text"
import { contentAreaLines, windowBodyLines, type ViewportSize } from "./viewport"

export type BuildDisplayOptions = {
  lastMessage: string
  viewport: ViewportSize
  hostLabel?: string
}

export function buildDisplayModel(editor: Editor, options: BuildDisplayOptions): DisplayModel {
  const { viewport, lastMessage, hostLabel = "Jemacs" } = options
  const buffer = editor.currentBuffer
  const pending = editor.keymaps.pendingSequence()
  const depth = editor.minibuffer && editor.minibufferDepthLevel > 1
    ? ` [${editor.minibufferDepthLevel}]`
    : ""

  const titleText = ` ${hostLabel} — ${editor.bufferDisplayName(buffer)}${buffer.dirty ? "*" : ""}`
  const title = applyTheme(titleText, [{ start: 0, end: titleText.length, face: "title" }], editor.theme)

  const completions = buildMinibufferCompletionsChunk(editor)
  const completionLines = minibufferCompletionLineCount(editor)
  // Minibuffer may carry a multi-line completion overlay (fido); steal those rows from the window stack.
  const overlayRows = editor.minibuffer ? editor.activeBuffer.text.split("\n").length - 1 : 0
  const areaLines = Math.max(2, contentAreaLines(viewport.rows) - completionLines - overlayRows)
  const windows = buildWindowTree(editor, editor.windowLayout, areaLines, viewport.cols)

  const minibuffer = buildMinibufferChunk(editor, depth)
  // The minibuffer chunk owns the prompt row while a minibuffer or isearch is
  // live; echoing lastMessage there too double-draws the prompt (t-e95ff513).
  const promptActive = editor.minibuffer || editor.isearch
  // Eldoc-style: when nothing else claims the echo area, surface the diagnostic at point.
  const echoMsg = promptActive ? "" : lastMessage || diagnosticEchoAtPoint(editor)
  const echoText = ` ${echoMsg}${pending && !editor.minibuffer ? `  [${pending}]` : ""}`
  const echo = applyTheme(echoText, [{ start: 0, end: echoText.length, face: "minibuffer" }], editor.theme)

  return {
    title,
    windows,
    minibufferCompletions: completions,
    minibufferCompletionLines: completionLines,
    minibuffer,
    echo,
    theme: editor.theme,
    viewport,
    hostLabel,
  }
}

function buildMinibufferCompletionsChunk(editor: Editor) {
  const display = editor.minibufferCompletionDisplay
  if (!display?.text) return applyTheme("", [], editor.theme)
  const text = display.text
  const spans = []
  if (display.selectedLine != null) {
    const lines = text.split("\n")
    let start = 0
    for (let i = 0; i < Math.min(display.selectedLine, lines.length); i++) start += lines[i]!.length + 1
    const end = start + (lines[display.selectedLine]?.length ?? 0)
    if (end > start) spans.push({ start, end, face: "region" as const })
  }
  return applyTheme(text, spans, editor.theme)
}

function minibufferCompletionLineCount(editor: Editor): number {
  const text = editor.minibufferCompletionDisplay?.text
  if (!text) return 0
  return Math.max(1, text.split("\n").length)
}

function buildMinibufferChunk(editor: Editor, depth: string) {
  if (editor.minibuffer) {
    const prompt = `${depth} ${editor.minibuffer.prompt}`
    const input = textWithCursor(editor.activeBuffer.text, editor.activeBuffer.point)
    const minibufferText = prompt + input
    return applyTheme(minibufferText, [
      { start: 0, end: prompt.length, face: "minibufferPrompt" },
      { start: prompt.length, end: minibufferText.length, face: "minibuffer" },
    ], editor.theme)
  }
  if (editor.isearch) {
    const state = editor.isearch
    const label = state.direction === 1 ? "I-search" : "I-search backward"
    const prompt = ` ${label}: `
    const query = textWithCursor(state.string, state.string.length)
    const isearchText = prompt + query
    return applyTheme(isearchText, [
      { start: 0, end: prompt.length, face: "minibufferPrompt" },
      { start: prompt.length, end: isearchText.length, face: "minibuffer" },
    ], editor.theme)
  }
  return applyTheme(" ", [], editor.theme)
}

function buildWindowTree(editor: Editor, layout: WindowNode, availableLines: number, availableCols?: number): WindowDisplayNode {
  if (layout.kind === "leaf") {
    return { kind: "leaf", pane: buildLeafPane(editor, layout, availableLines, availableCols), lineBudget: availableLines }
  }
  const lines = splitLineBudget(availableLines, layout.direction, layout.firstRatio)
  const cols = splitColBudget(availableCols, layout.direction, layout.firstRatio)
  return {
    kind: "split",
    direction: layout.direction,
    firstRatio: layout.firstRatio,
    first: buildWindowTree(editor, layout.first, lines.first, cols.first),
    second: buildWindowTree(editor, layout.second, lines.second, cols.second),
  }
}

function buildLeafPane(editor: Editor, leaf: WindowLeaf, availableLines: number, availableCols?: number) {
  const selected = leaf.id === editor.selectedWindowId
  const maxLines = windowBodyLines(availableLines)
  const buffer = editor.buffers.get(leaf.bufferId)
  if (!buffer) {
    return {
      id: leaf.id,
      bufferId: leaf.bufferId,
      selected,
      dedicated: leaf.dedicated,
      body: plainThemedText(""),
      modeline: applyTheme(" (empty)", [], editor.theme),
      clickState: { startLine: 0, gutterPrefixLen: 0 },
      bodyLineBudget: maxLines,
      syncText: "",
      syncPoint: 0,
      syncSpans: [],
      textScale: 1,
    }
  }

  const point = selected ? buffer.point : leaf.point
  const dirty = buffer.dirty ? "*" : ""
  const { line, col } = pointLineCol(buffer.text, point)
  if (selected) editor.syncSelectedWindowViewport(maxLines)
  const startLine = findWindowLeaf(editor.windowLayout, leaf.id)?.startLine ?? leaf.startLine

  const spans = [...editor.fontLock(buffer)]
  if (selected && editor.isearch) {
    const match = isearchMatchSpan(buffer, editor.isearch)
    if (match) spans.push(match)
    spans.push(...isearchLazyHighlightSpans(buffer, editor.isearch))
  }
  const showLineNumbers = buffer.kind !== "minibuffer" && editor.showLineNumbers(buffer)
  const mark = selected && buffer.markActive ? buffer.mark : null
  const syncSpans = bufferHighlightSpans(point, mark, spans)
  // Selective-display (org folding etc.): mode may project buffer text/offsets onto a shorter body.
  const filt = modeFeature(buffer.mode, "displayFilter")?.(buffer)
  const dText = filt?.text ?? buffer.text
  const dPoint = filt ? filt.map(point) : point
  const dMark = filt && mark != null ? filt.map(mark) : mark
  const dSpans = filt ? spans.map(s => ({ ...s, start: filt.map(s.start), end: filt.map(s.end) })) : spans
  const clickState = windowClickState(dText, startLine, maxLines, showLineNumbers)
  // Hosts hard-wrap overflowing rows at column 0, which paints continuation
  // text into the next line's gutter (t-16be1a86). Pre-wrap here so every
  // continuation row carries the gutter's left padding.
  const body = wrapBodyRows(
    visibleStyledTextFromStart(dText, dPoint, startLine, {
      mark: dMark,
      spans: dSpans,
      theme: editor.theme,
      buffer,
      maxLines,
      showLineNumbers,
      showCursor: selected,
    }),
    availableCols,
    clickState.gutterPrefixLen,
    maxLines,
  )
  const lighters = editor.minorModeLighters(buffer) + textScaleLighter(buffer)
  const region = selected && buffer.markActive && buffer.mark != null
    ? `  (${Math.abs(point - buffer.mark)} chars)`
    : ""
  const modelineText = ` ${buffer.mode}${lighters}  ${editor.bufferDisplayName(buffer)}${dirty}${leaf.dedicated ? " [D]" : ""}  line ${line}, col ${col}${region}`
  const modeline = applyTheme(modelineText, [{
    start: 0,
    end: modelineText.length,
    face: selected ? "modeLine" : "modeLineInactive",
  }], editor.theme)

  return {
    id: leaf.id,
    bufferId: leaf.bufferId,
    selected,
    dedicated: leaf.dedicated,
    body,
    modeline,
    clickState,
    bodyLineBudget: maxLines,
    syncText: buffer.text,
    syncPoint: point,
    syncSpans,
    textScale: textScaleFactor(buffer),
  }
}

function splitLineBudget(availableLines: number, direction: "horizontal" | "vertical", firstRatio = 0.5): { first: number; second: number } {
  if (direction === "horizontal") {
    return { first: availableLines, second: availableLines }
  }
  const first = proportionalBudget(availableLines, firstRatio, 3)
  return { first, second: Math.max(3, availableLines - first) }
}

function splitColBudget(cols: number | undefined, direction: "horizontal" | "vertical", firstRatio = 0.5): { first?: number; second?: number } {
  if (cols == null) return {}
  if (direction === "vertical") return { first: cols, second: cols }
  const first = proportionalBudget(cols, firstRatio, 1)
  return { first, second: cols - first }
}

function proportionalBudget(total: number, firstRatio: number, min: number): number {
  if (total <= min * 2) return Math.floor(total / 2)
  const ratio = Math.max(0.05, Math.min(0.95, firstRatio))
  return Math.max(min, Math.min(total - min, Math.floor(total * ratio)))
}

/** Hard-wrap themed body rows at `cols`, left-padding continuation rows by
 *  `padLen` so they align under the buffer text, not the line-number gutter.
 *  Output is capped at `maxRows`; when wrapping would exceed that, leading
 *  rows are dropped so the cursor (always in the last logical line of the
 *  input window) stays on screen. */
function wrapBodyRows(body: ThemedText, cols: number | undefined, padLen: number, maxRows?: number): ThemedText {
  if (cols == null || cols <= padLen + 1) return body
  const pad = " ".repeat(padLen)
  // Build as row-chunk-lists so we can trim from the top without re-splitting.
  const rows: ThemedChunk[][] = [[]]
  let col = 0
  for (const chunk of body.chunks) {
    let run = ""
    const cur = () => rows[rows.length - 1]!
    const flush = () => { if (run) { cur().push({ ...chunk, text: run }); run = "" } }
    for (const ch of chunk.text) {
      if (ch === "\n") { flush(); rows.push([]); col = 0; continue }
      if (col >= cols) { flush(); rows.push([{ text: pad }]); col = padLen }
      run += ch; col++
    }
    flush()
  }
  const kept = maxRows != null && rows.length > maxRows ? rows.slice(rows.length - maxRows) : rows
  const out: ThemedChunk[] = []
  for (let i = 0; i < kept.length; i++) {
    if (i > 0) out.push({ text: "\n" })
    out.push(...kept[i]!)
  }
  return { chunks: out }
}

/** First diagnostic message whose range covers point in the selected buffer, else "". */
function diagnosticEchoAtPoint(editor: Editor): string {
  const buffer = editor.currentBuffer
  const lsp = editor.lsp
  if (!lsp || !buffer.path) return ""
  for (const ws of lsp.bufferWorkspaces(buffer)) {
    for (const diag of diagnosticsForBuffer(buffer, ws)) {
      const start = positionToPoint(buffer.text, diag.range.start)
      const end = positionToPoint(buffer.text, diag.range.end)
      if (buffer.point >= start && buffer.point < end) return diag.message
    }
  }
  return ""
}

function pointLineCol(text: string, point: number): { line: number; col: number } {
  const before = text.slice(0, Math.max(0, Math.min(point, text.length)))
  const lines = before.split("\n")
  return { line: lines.length, col: lines.at(-1)!.length + 1 }
}
