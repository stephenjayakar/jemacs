import type { Editor, MinibufferCompletionDisplay } from "../kernel/editor"
import type { BufferModel } from "../kernel/buffer"
import { textScaleFactor, textScaleLighter } from "../core/text-scale"
import { defvar, getCustom } from "../runtime/custom"
import { isearchLazyHighlightSpans, isearchMatchSpan } from "../kernel/isearch"
import { type WindowLeaf, type WindowNode } from "../kernel/window"
import { diagnosticsForBuffer } from "../lsp/diagnostics"
import { positionToPoint } from "../lsp/positions"
import { modeFeature, type TextSpan } from "../modes/mode"
import { applyTheme, type Theme } from "./theme"
import type { ThemedText } from "./themed-text"
import { TERMINAL_SURFACE_LOCAL, type TerminalSurfaceModel } from "./terminal-surface"

/** Plugin-contributed modeline segments (Emacs `mode-line-misc-info`). Each fn
 *  returns a string appended after the minor-mode lighters; empty string = nothing. */
defvar("mode-line-misc-info", [] as Array<(buffer: BufferModel) => string>,
  "Functions appended to the mode line after minor-mode lighters.")

/** Viewport-independent description of one window's contents. A host that lays
 *  out its own text (DOM, web) consumes this directly; the char-grid path
 *  (`layoutCharGrid`) projects it into wrapped rows. */
export type LogicalPane = {
  bufferId: string
  /** Backing buffer; carried so char-grid layout can resolve buffer-local face
   *  remaps via `resolveFace(face, theme, buffer)`. Hosts that bypass char-grid
   *  layout may ignore this and rely on the flat fields below. */
  buffer?: BufferModel
  /** Raw buffer text (also used as `syncText` for native-editor hosts). */
  text: string
  /** Buffer text after the mode's `displayFilter` (markup hidden); same as
   *  `text` when no filter is active. */
  displayText: string
  /** Maps a `text` offset to the corresponding `displayText` offset. Unset when
   *  no display filter is active (treat as identity). */
  displayMap?: (n: number) => number
  /** Font-lock + LSP + overlay-source + isearch spans, buffer-absolute. Region
   *  is *not* included here — derive it from `point`/`mark`. */
  spans: TextSpan[]
  /** Font-lock spans only (no isearch). Kept separate so visual-row weighting
   *  matches the pre-isearch span set the legacy path used. */
  fontLockSpans: TextSpan[]
  point: number
  mark: number | null
  markActive: boolean
  selected: boolean
  startLine: number
  mode: string
  modeline: ThemedText
  /** Modeline variant used when a matching terminal surface is active. */
  terminalModeline?: ThemedText
  /** Raw terminal grid from `buffer.locals[TERMINAL_SURFACE_LOCAL]` (dims unchecked). */
  terminalSurface?: TerminalSurfaceModel
  readOnly: boolean
  showLineNumbers: boolean
  textScale: number
  locals: ReadonlyMap<string, unknown>
}

export type LogicalWindowNode =
  | { kind: "leaf"; id: string; pane: LogicalPane; dedicated: boolean }
  | { kind: "split"; direction: "horizontal" | "vertical"; ratio?: number; first: LogicalWindowNode; second: LogicalWindowNode }

export type LogicalMinibuffer = {
  text: string
  point: number
  prompt: string
}

export type LogicalModel = {
  windows: LogicalWindowNode
  selectedWindowId: string
  minibuffer: LogicalMinibuffer | null
  completion: MinibufferCompletionDisplay | null
  /** Extra rows the minibuffer overlay (fido inline list) steals from the window stack. */
  overlayRows: number
  echo: ThemedText
  title: ThemedText
  theme: Theme
  hostLabel: string
}

export type BuildLogicalOptions = {
  lastMessage?: string
  hostLabel?: string
}

/** Walk `editor.windowLayout` into a viewport-independent `LogicalModel`.
 *  Pure: reads `editor` but never mutates it. */
export function buildLogicalModel(editor: Editor, options: BuildLogicalOptions = {}): LogicalModel {
  const { lastMessage, hostLabel = "Jemacs" } = options
  const buffer = editor.currentBuffer
  const pending = editor.keymaps.pendingSequence()
  const depth = editor.minibuffer && editor.minibufferDepthLevel > 1
    ? ` [${editor.minibufferDepthLevel}]`
    : ""

  const titleText = ` ${hostLabel} — ${editor.bufferDisplayName(buffer)}${buffer.dirty ? "*" : ""}`
  const title = applyTheme(titleText, [{ start: 0, end: titleText.length, face: "title" }], editor.theme)

  const windows = buildLogicalWindowTree(editor, editor.windowLayout)
  const minibuffer = logicalMinibuffer(editor, depth)
  const overlayRows = editor.minibuffer ? editor.activeBuffer.text.split("\n").length - 1 : 0

  // The minibuffer chunk owns the prompt row while a minibuffer or isearch is
  // live; echoing lastMessage there too double-draws the prompt (t-e95ff513).
  const promptActive = editor.minibuffer || editor.isearch
  // Eldoc-style: when nothing else claims the echo area, surface the diagnostic at point.
  const echoMsg = promptActive ? "" : lastMessage || diagnosticEchoAtPoint(editor)
  const echoText = ` ${echoMsg}${pending && !editor.minibuffer ? `  [${pending}]` : ""}`
  const echo = applyTheme(echoText, [{ start: 0, end: echoText.length, face: "minibuffer" }], editor.theme)

  return {
    windows,
    selectedWindowId: editor.selectedWindowId,
    minibuffer,
    completion: editor.minibufferCompletionDisplay,
    overlayRows,
    echo,
    title,
    theme: editor.theme,
    hostLabel,
  }
}

function buildLogicalWindowTree(editor: Editor, layout: WindowNode): LogicalWindowNode {
  if (layout.kind === "leaf") {
    return {
      kind: "leaf",
      id: layout.id,
      pane: buildLogicalPane(editor, layout),
      dedicated: layout.dedicated,
    }
  }
  return {
    kind: "split",
    direction: layout.direction,
    ratio: layout.firstRatio,
    first: buildLogicalWindowTree(editor, layout.first),
    second: buildLogicalWindowTree(editor, layout.second),
  }
}

function buildLogicalPane(editor: Editor, leaf: WindowLeaf): LogicalPane {
  const selected = leaf.id === editor.selectedWindowId
  const buffer = editor.buffers.get(leaf.bufferId)
  if (!buffer) {
    return {
      bufferId: leaf.bufferId,
      buffer: undefined,
      text: "",
      displayText: "",
      spans: [],
      fontLockSpans: [],
      point: 0,
      mark: null,
      markActive: false,
      selected,
      startLine: 0,
      mode: "",
      modeline: applyTheme(" (empty)", [], editor.theme),
      readOnly: false,
      showLineNumbers: false,
      textScale: 1,
      locals: emptyLocals,
    }
  }

  const point = selected ? buffer.point : leaf.point
  const fontLockSpans = [...editor.fontLock(buffer)]
  const spans = [...fontLockSpans]
  if (selected && editor.isearch) {
    const match = isearchMatchSpan(buffer, editor.isearch)
    if (match) spans.push(match)
    spans.push(...isearchLazyHighlightSpans(buffer, editor.isearch))
  }
  const filt = modeFeature(buffer.mode, "displayFilter")?.(buffer)
  const surface = buffer.locals.get(TERMINAL_SURFACE_LOCAL) as TerminalSurfaceModel | undefined
  const dirty = buffer.dirty ? "*" : ""

  return {
    bufferId: leaf.bufferId,
    buffer,
    text: buffer.text,
    displayText: filt?.text ?? buffer.text,
    displayMap: filt ? filt.map : undefined,
    spans,
    fontLockSpans,
    point,
    mark: buffer.mark,
    markActive: selected && buffer.markActive,
    selected,
    startLine: leaf.startLine,
    mode: buffer.mode,
    modeline: modelineFor(editor, buffer, leaf, point, selected, dirty),
    terminalModeline: surface
      ? themedModeline(terminalModelineText(editor, buffer, dirty, leaf.dedicated), selected, editor.theme)
      : undefined,
    terminalSurface: surface,
    readOnly: buffer.readOnly,
    showLineNumbers: buffer.kind !== "minibuffer" && editor.showLineNumbers(buffer),
    textScale: textScaleFactor(buffer),
    locals: buffer.locals,
  }
}

function modelineFor(
  editor: Editor,
  buffer: BufferModel,
  leaf: WindowLeaf,
  point: number,
  selected: boolean,
  dirty: string,
): ThemedText {
  const { line, col } = pointLineCol(buffer.text, point)
  const misc = (getCustom<Array<(b: BufferModel) => string>>("mode-line-misc-info") ?? [])
    .map(f => f(buffer)).join("")
  const lighters = editor.minorModeLighters(buffer) + textScaleLighter(buffer) + misc
  const region = selected && buffer.markActive && buffer.mark != null
    ? `  (${Math.abs(point - buffer.mark)} chars)`
    : ""
  const text = ` ${buffer.mode}${lighters}  ${editor.bufferDisplayName(buffer)}${dirty}${leaf.dedicated ? " [D]" : ""}  line ${line}, col ${col}${region}`
  return themedModeline(text, selected, editor.theme)
}

function terminalModelineText(editor: Editor, buffer: BufferModel, dirty: string, dedicated: boolean): string {
  const misc = (getCustom<Array<(b: BufferModel) => string>>("mode-line-misc-info") ?? [])
    .map(f => f(buffer)).join("")
  const lighters = editor.minorModeLighters(buffer) + textScaleLighter(buffer) + misc
  return ` ${buffer.mode}${lighters}  ${editor.bufferDisplayName(buffer)}${dirty}${dedicated ? " [D]" : ""}  terminal`
}

function themedModeline(text: string, selected: boolean, theme: Theme): ThemedText {
  return applyTheme(text, [{
    start: 0,
    end: text.length,
    face: selected ? "modeLine" : "modeLineInactive",
  }], theme)
}

function logicalMinibuffer(editor: Editor, depth: string): LogicalMinibuffer | null {
  if (editor.minibuffer) {
    return {
      prompt: `${depth} ${editor.minibuffer.prompt}`,
      text: editor.activeBuffer.text,
      point: editor.activeBuffer.point,
    }
  }
  if (editor.isearch) {
    const state = editor.isearch
    const label = state.direction === 1 ? "I-search" : "I-search backward"
    return { prompt: ` ${label}: `, text: state.string, point: state.string.length }
  }
  return null
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

export function pointLineCol(text: string, point: number): { line: number; col: number } {
  const before = text.slice(0, Math.max(0, Math.min(point, text.length)))
  const lines = before.split("\n")
  return { line: lines.length, col: lines.at(-1)!.length + 1 }
}

const emptyLocals: ReadonlyMap<string, unknown> = new Map()
