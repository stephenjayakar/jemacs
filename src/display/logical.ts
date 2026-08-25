import type { Editor, MinibufferCompletionDisplay } from "../kernel/editor"
import type { BufferModel } from "../kernel/buffer"
import { textScaleFactor, textScaleLighter } from "../core/text-scale"
import { appName } from "../runtime/app-name"
import { defvar, getCustom } from "../runtime/custom"
import { isearchLazyHighlightSpans, isearchMatchSpan } from "../kernel/isearch"
import { findWindowLeaf, type ChildFrameParameters, type WindowLeaf, type WindowNode } from "../kernel/window"
import { diagnosticsForBuffer } from "../lsp/diagnostics"
import { positionToPoint } from "../lsp/positions"
import { modeFeature, type FontLockRange, type GutterDecoration, type TableSurfaceModel, type TextSpan, type WebSurfaceModel } from "../modes/mode"
import { applyTheme, type Theme } from "./theme"
import { FACE_REMAP_KEY } from "./face-resolve"
import type { ThemedText } from "./themed-text"
import { TERMINAL_SURFACE_LOCAL, type TerminalSurfaceModel } from "./terminal-surface"
import { applyRestrictionDisplayFilter, type DisplayFilterResult } from "./display-wrap"
import { tabBarLayout, tabBarVisible } from "./tab-bar"

/** Plugin-contributed modeline segments (Emacs `mode-line-misc-info`). Each fn
 *  returns a string appended after the minor-mode lighters; empty string = nothing. */
defvar("mode-line-misc-info", [] as Array<(buffer: BufferModel) => string>,
  "Functions appended to the mode line after minor-mode lighters.")

/** What downstream `resolveFace` actually reads from the buffer. Carrying the
 *  full `BufferModel` would alias mutable kernel state into the display model
 *  and defeat serialization (t-audit2-7eecc353). */
type FaceRemapSource = { readonly locals: ReadonlyMap<string, unknown> }

/** Viewport-independent description of one window's contents. A host that lays
 *  out its own text (DOM, web) consumes this directly; the char-grid path
 *  (`layoutCharGrid`) projects it into wrapped rows. */
export type LogicalPane = {
  bufferId: string
  /** Snapshot of the buffer's face-remap locals so char-grid layout can call
   *  `resolveFace(face, theme, buffer)`. Typed as `BufferModel` only so existing
   *  consumers (`applyTheme`, `computeLineVisualRows`) keep typechecking; at
   *  runtime it is a `{ locals }` snapshot, never the live kernel object. */
  buffer?: BufferModel
  /** Raw buffer text (also used as `syncText` for native-editor hosts). */
  text: string
  /** Buffer text after the mode's `displayFilter` (markup hidden); same as
   *  `text` when no filter is active. */
  displayText: string
  /** Pre-evaluated `text → displayText` offset pairs for every offset the
   *  renderer maps (point, mark, span boundaries). Plain data so the model
   *  survives JSON; absent when no display filter is active. */
  displayOffsets?: ReadonlyArray<readonly [raw: number, display: number]>
  /** @deprecated Functions are dropped by JSON; call {@link paneDisplayMap}
   *  host-side instead (it derives the closure from `displayOffsets`). Kept
   *  populated only until char-grid-layout / web-layout migrate
   *  (t-audit2-f8e12ae6). */
  displayMap?: (n: number) => number
  /** Inverse of `displayMap`, used by host mouse hit-testing. */
  displayUnmap?: (n: number) => number
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
  /** Window-local popup rows rendered between the body and mode line. */
  footer?: { text: string; spans?: TextSpan[] }
  /** Raw terminal grid from `buffer.locals[TERMINAL_SURFACE_LOCAL]` (dims unchecked). */
  terminalSurface?: TerminalSurfaceModel
  /** Optional rich table/list pane model. Plain text remains the fallback. */
  tableSurface?: TableSurfaceModel
  webSurface?: WebSurfaceModel
  readOnly: boolean
  showLineNumbers: boolean
  gutterDecorations?: GutterDecoration[]
  textScale: number
  locals: ReadonlyMap<string, unknown>
}

export type LogicalWindowNode =
  | { kind: "leaf"; id: string; pane: LogicalPane; dedicated: boolean }
  | { kind: "split"; direction: "horizontal" | "vertical"; ratio?: number; first: LogicalWindowNode; second: LogicalWindowNode }

export type LogicalChildFrame = {
  id: string
  parentFrameId: string
  parameters: ChildFrameParameters
  pane: LogicalPane
}

export type LogicalMinibuffer = {
  text: string
  point: number
  prompt: string
  mask?: boolean
  /** Active-region end, as an offset into `text`. The minibuffer is a real
   *  buffer, so C-SPC sets a mark there; hosts paint point..mark like any
   *  other window. Null when no region is active. */
  mark?: number | null
}

export type LogicalModel = {
  windows: LogicalWindowNode
  /** Tab-bar row, drawn above the window stack. Absent when the bar is hidden. */
  tabBar?: { text: string; spans: TextSpan[] } | null
  childFrames: LogicalChildFrame[]
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
  /** Render this frame instead of the selected one (multi-frame GUI hosts). */
  frameId?: string
}

/** Walk `editor.windowLayout` into a viewport-independent `LogicalModel`.
 *  Pure: reads `editor` but never mutates it. */
export function buildLogicalModel(editor: Editor, options: BuildLogicalOptions = {}): LogicalModel {
  const { lastMessage, hostLabel = "Jemacs", frameId } = options
  // Hosts that show several frames at once (the Electron GUI) render each one
  // by id; everything else renders whichever frame is selected.
  const frame = frameId ? editor.frames.find(candidate => candidate.id === frameId) : undefined
  const layout = frame?.layout ?? editor.windowLayout
  const selectedWindowId = frame?.selectedWindowId ?? editor.selectedWindowId
  const buffer = frame && frame.id !== editor.selectedFrameId
    ? editor.buffers.get(findWindowLeaf(layout, selectedWindowId)?.bufferId ?? "") ?? editor.currentBuffer
    : editor.currentBuffer
  const pending = editor.keymaps.pendingSequence()
  const depth = editor.minibuffer && editor.minibufferDepthLevel > 1
    ? ` [${editor.minibufferDepthLevel}]`
    : ""

  // `jemacs-app-name` renames every surface at once; when it is empty each host
  // keeps its own name ("Jemacs GUI", "Jemacs OpenTUI", ...).
  const titleText = ` ${appName(hostLabel)} — ${editor.bufferDisplayName(buffer)}${buffer.dirty ? "*" : ""}`
  const title = applyTheme(titleText, [{ start: 0, end: titleText.length, face: "title" }], editor.theme)

  const windows = buildLogicalWindowTree(editor, layout, selectedWindowId)
  // The bar belongs to the frame being rendered, not to the selected one, so a
  // background GUI frame draws its own tabs.
  const tabBarFrame = frame ?? editor.selectedFrame
  const tabBar = tabBarVisible(editor, tabBarFrame) ? tabBarLayout(editor, tabBarFrame) : null
  const childFrames = [...editor.childFrames.values()]
    .filter(frame => frame.visible)
    .map(frame => ({
      id: frame.id,
      parentFrameId: frame.parentFrameId,
      parameters: frame.parameters,
      pane: buildLogicalPane(editor, frame.window, selectedWindowId),
    }))
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
    tabBar: tabBar ? { text: tabBar.text, spans: tabBar.spans } : undefined,
    childFrames,
    selectedWindowId,
    minibuffer,
    completion: editor.minibufferCompletionDisplay,
    overlayRows,
    echo,
    title,
    theme: editor.theme,
    hostLabel,
  }
}

function buildLogicalWindowTree(editor: Editor, layout: WindowNode, selectedWindowId: string): LogicalWindowNode {
  if (layout.kind === "leaf") {
    return {
      kind: "leaf",
      id: layout.id,
      pane: buildLogicalPane(editor, layout, selectedWindowId),
      dedicated: layout.dedicated,
    }
  }
  return {
    kind: "split",
    direction: layout.direction,
    ratio: layout.firstRatio,
    first: buildLogicalWindowTree(editor, layout.first, selectedWindowId),
    second: buildLogicalWindowTree(editor, layout.second, selectedWindowId),
  }
}

function buildLogicalPane(editor: Editor, leaf: WindowLeaf, selectedWindowId: string): LogicalPane {
  const selected = leaf.id === selectedWindowId
  const buffer = editor.buffers.get(leaf.bufferId)
  const footer = editor.transient?.windowId === leaf.id ? editor.transientDisplay() : null
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
      footer: footer ?? undefined,
      readOnly: false,
      showLineNumbers: false,
      gutterDecorations: [],
      textScale: 1,
      locals: emptyLocals,
    }
  }

  const point = selected ? buffer.point : Math.max(buffer.pointMin, Math.min(buffer.pointMax, leaf.point))
  const fontLockSpans = clipSpansToRestriction([...editor.fontLock(buffer, visibleFontLockRange(buffer, leaf))], buffer)
  const spans = [...fontLockSpans]
  if (selected && editor.isearch) {
    const match = isearchMatchSpan(buffer, editor.isearch)
    if (match && match.end > buffer.pointMin && match.start < buffer.pointMax) spans.push(clipSpanToRestriction(match, buffer))
    spans.push(...isearchLazyHighlightSpans(buffer, editor.isearch, buffer.pointMin, buffer.pointMax))
  }
  const filt = safeDisplayFilter(buffer)
  const displayOffsets = filt ? evalDisplayOffsets(filt.map, point, buffer.mark, spans) : undefined
  const locals = snapshotLocals(buffer.locals)
  const bufferSnapshot = { locals } satisfies FaceRemapSource as unknown as BufferModel
  const surface = locals.get(TERMINAL_SURFACE_LOCAL) as TerminalSurfaceModel | undefined
  const dirty = buffer.dirty ? "*" : ""

  return {
    bufferId: leaf.bufferId,
    buffer: bufferSnapshot,
    text: buffer.text,
    displayText: filt?.text ?? buffer.text,
    displayOffsets,
    displayMap: paneDisplayMap({ displayOffsets }),
    displayUnmap: filt?.unmap,
    spans,
    fontLockSpans,
    point,
    mark: buffer.mark,
    markActive: selected && buffer.markActive,
    selected,
    startLine: leaf.startLine,
    mode: buffer.mode,
    modeline: modelineFor(editor, buffer, leaf, point, selected, dirty),
    footer: footer ?? undefined,
    terminalModeline: surface
      ? themedModeline(terminalModelineText(editor, buffer, dirty, leaf.dedicated), selected, editor.theme)
      : undefined,
    terminalSurface: surface,
    tableSurface: safeTableSurface(buffer),
    webSurface: safeWebSurface(buffer),
    readOnly: buffer.readOnly,
    showLineNumbers: buffer.kind !== "minibuffer" && editor.showLineNumbers(buffer),
    gutterDecorations: editor.gutterDecorations(buffer),
    textScale: textScaleFactor(buffer),
    locals,
  }
}

function visibleFontLockRange(buffer: BufferModel, leaf: WindowLeaf): FontLockRange {
  const rows = numberLocal(buffer, "window-body-rows") ?? 80
  const margin = Math.max(80, rows * 4)
  const baseLine = buffer.lineAt(buffer.pointMin)
  const startLine = Math.max(0, baseLine + leaf.startLine - margin)
  const endLine = Math.min(buffer.lineCount, baseLine + leaf.startLine + rows + margin)
  const start = Math.max(buffer.pointMin, buffer.lineStarts[startLine] ?? 0)
  const end = Math.max(start, Math.min(buffer.pointMax, endLine < buffer.lineCount
    ? buffer.lineStarts[endLine]!
    : buffer.text.length))
  return { startLine, endLine, start, end }
}

function numberLocal(buffer: BufferModel, key: string): number | null {
  const value = buffer.locals.get(key)
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** Guard the mode's `displayFilter` so a buggy plugin degrades to identity
 *  instead of taking the frame down (t-audit2-ab15abf8). */
function safeDisplayFilter(buffer: BufferModel): DisplayFilterResult | null {
  try {
    return applyRestrictionDisplayFilter(buffer, modeFeature(buffer.mode, "displayFilter")?.(buffer) ?? null)
  } catch (err) {
    console.error(`display-filter for mode '${buffer.mode}' threw:`, err)
    return applyRestrictionDisplayFilter(buffer, null)
  }
}

function clipSpansToRestriction(spans: TextSpan[], buffer: BufferModel): TextSpan[] {
  if (!buffer.isNarrowed) return spans
  return spans
    .filter(span => span.end > buffer.pointMin && span.start < buffer.pointMax)
    .map(span => clipSpanToRestriction(span, buffer))
}

function clipSpanToRestriction<T extends TextSpan>(span: T, buffer: BufferModel): T {
  return {
    ...span,
    start: Math.max(buffer.pointMin, span.start),
    end: Math.min(buffer.pointMax, span.end),
  }
}

function safeTableSurface(buffer: BufferModel): TableSurfaceModel | undefined {
  try {
    return modeFeature(buffer.mode, "tableSurface")?.(buffer) ?? undefined
  } catch (err) {
    console.error(`table-surface for mode '${buffer.mode}' threw:`, err)
    return undefined
  }
}

/** Guard the mode's `webSurface` the same way, so a bad plugin degrades to body text. */
function safeWebSurface(buffer: BufferModel): WebSurfaceModel | undefined {
  try {
    return modeFeature(buffer.mode, "webSurface")?.(buffer) ?? undefined
  } catch (err) {
    console.error(`web-surface for mode '${buffer.mode}' threw:`, err)
    return undefined
  }
}

/** Guard each `mode-line-misc-info` segment so one bad entry renders an inline
 *  marker instead of crashing the modeline (t-audit2-ab15abf8). */
function safeMiscInfo(buffer: BufferModel): string {
  const fns = getCustom<Array<(b: BufferModel) => string>>("mode-line-misc-info") ?? []
  return fns.map(f => {
    try { return f(buffer) } catch { return " [misc-err]" }
  }).join("")
}

/** Pre-evaluate the mode's offset map at every offset the renderer will query
 *  (point, mark, span boundaries). The resulting table is plain data; the
 *  per-buffer closure is dropped here (t-audit2-f8e12ae6). */
function evalDisplayOffsets(
  map: (n: number) => number,
  point: number,
  mark: number | null,
  spans: readonly TextSpan[],
): ReadonlyArray<readonly [number, number]> {
  const raw = new Set<number>([point])
  if (mark != null) raw.add(mark)
  for (const s of spans) { raw.add(s.start); raw.add(s.end) }
  return [...raw].sort((a, b) => a - b).map(n => [n, map(n)] as const)
}

/** Snapshot `buffer.locals` so post-build kernel mutations don't leak into the
 *  display model. The face-remap entry is itself a `Map` that
 *  `faceRemapAddRelative` mutates in place, so it needs its own copy — a
 *  shallow `new Map(locals)` would still alias it (t-audit2-7eecc353). */
function snapshotLocals(src: ReadonlyMap<string, unknown>): Map<string, unknown> {
  const out = new Map(src)
  const remaps = out.get(FACE_REMAP_KEY)
  if (remaps instanceof Map) out.set(FACE_REMAP_KEY, new Map(remaps))
  return out
}

/** Reconstruct a `displayMap` from the pre-evaluated table. Closes over the
 *  table only — never the buffer or the mode's original closure. Exported so a
 *  host that JSON-round-trips `displayOffsets` can rebuild the function on its
 *  side (`displayMap` itself is dropped by JSON). */
export function offsetTableMap(table: ReadonlyArray<readonly [number, number]>): (n: number) => number {
  const lut = new Map(table)
  return n => lut.get(n) ?? n
}

/** Host-side `text → displayText` offset map for a pane. The closure is built
 *  here, from the serializable `displayOffsets` descriptor — never carried on
 *  the pane and never the mode's `displayFilter` closure (t-audit2-f8e12ae6).
 *  Returns `undefined` (treat as identity) when no display filter is active. */
export function paneDisplayMap(
  pane: { readonly displayOffsets?: ReadonlyArray<readonly [number, number]> },
): ((n: number) => number) | undefined {
  return pane.displayOffsets ? offsetTableMap(pane.displayOffsets) : undefined
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
  const lighters = editor.minorModeLighters(buffer) + textScaleLighter(buffer) + safeMiscInfo(buffer)
  const region = selected && buffer.markActive && buffer.mark != null
    ? `  (${Math.abs(point - buffer.mark)} chars)`
    : ""
  const text = ` ${buffer.mode}${lighters}  ${editor.bufferDisplayName(buffer)}${dirty}${leaf.dedicated ? " [D]" : ""}  line ${line}, col ${col}${region}`
  return themedModeline(text, selected, editor.theme)
}

function terminalModelineText(editor: Editor, buffer: BufferModel, dirty: string, dedicated: boolean): string {
  const lighters = editor.minorModeLighters(buffer) + textScaleLighter(buffer) + safeMiscInfo(buffer)
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
    const buffer = editor.activeBuffer
    return {
      prompt: `${depth} ${editor.minibuffer.prompt}`,
      text: buffer.text,
      point: buffer.point,
      mask: editor.minibuffer.mask,
      mark: buffer.markActive ? buffer.mark : null,
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
