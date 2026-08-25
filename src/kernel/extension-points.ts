import type { BufferModel } from "./buffer"
import type { Keymap } from "./keymap"

/**
 * Kernel-owned structural types + the dependency-inversion seam that lets the
 * kernel stay independent of modes/, display/, themes/, lsp/ (ARCHITECTURE.md
 * 06-05 finding #2). Upper layers import these types from here; modes/ and
 * display/ self-wire via `setModeSystem` / `setDisplaySystem` at module load,
 * so a bare `new Editor()` works with no-op defaults and the real behaviour
 * appears as soon as those modules are imported.
 */

// ── Faces / spans ───────────────────────────────────────────────────────────

export type FaceName =
  | "default"
  | "keyword"
  | "string"
  | "comment"
  | "builtin"
  | "function"
  | "type"
  | "number"
  | "constant"
  | "preprocessor"
  | "doc"
  | "directory"
  | "region"
  /** Emacs `highlight`: the transient "this is the current row" face. Distinct
   *  from `region`, which means "point..mark is active". */
  | "highlight"
  | "isearch"
  | "lazyHighlight"
  | "modeLine"
  | "modeLineInactive"
  | "minibuffer"
  | "minibufferPrompt"
  | "title"
  | "warning"
  | "error"
  | "lineNumber"
  | "lineNumberCurrent"
  | "warning"
  | "success"
  | "variable"
  | "helpLink"
  | "shadow"
  // cus-edit.el's own faces, used by every Custom buffer.
  | "custom-variable-tag"
  | "custom-variable-obsolete"
  | "custom-face-tag"
  | "custom-group-tag"
  | "custom-group-tag-1"
  | "custom-group-subtitle"
  | "custom-group-rule"
  | "custom-state"
  | "custom-button"
  | "custom-button-pressed"
  | "custom-button-unraised"
  | "custom-documentation"
  | "custom-link"
  | "custom-visibility"
  | "custom-comment"
  | "custom-comment-tag"
  | "custom-modified"
  | "custom-set"
  | "custom-changed"
  | "custom-saved"
  | "custom-themed"
  | "custom-rogue"
  | "custom-invalid"
  | "widget-field"
  | "widget-inactive"
  | "diffHeader"
  | "diffFileHeader"
  | "diffIndex"
  | "diffHunkHeader"
  | "diffRemoved"
  | "diffAdded"
  | "diffChanged"
  | "diffContext"
  | "diffFunction"
  | "diffNonexistent"
  | "diffRefineChanged"
  | "diffRefineRemoved"
  | "diffRefineAdded"
  | "magit-section-highlight"
  | "magit-section-heading"
  | "magit-section-secondary-heading"
  | "magit-section-heading-selection"
  | "magit-section-child-count"
  | "magit-left-margin"
  | "markdown-header-face-1"
  | "markdown-header-face-2"
  | "markdown-header-face-3"
  | "markdown-header-face-4"
  | "markdown-header-face-5"
  | "markdown-header-face-6"
  | "markdown-markup"
  | "markdown-emphasis"
  | "markdown-strong"
  | "markdown-link"
  | "markdown-strikethrough"
  | "markdown-inline-code"
  | "markdown-blockquote"
  // tab-bar.el's faces, drawn by the tab bar above the window stack.
  | "tab-bar"
  | "tab-bar-tab"
  | "tab-bar-tab-inactive"

export type TextSpan = {
  start: number
  end: number
  face: FaceName
  style?: FaceStyle
}

export type GutterDecoration = {
  /** One-based source line. */
  line: number
  glyph: string
  face: FaceName
  priority?: number
  title?: string
}

export type FontLockRange = {
  /** 0-indexed first line included in the requested highlight window. */
  startLine: number
  /** 0-indexed line just past the requested highlight window. */
  endLine: number
  /** Buffer offset for `startLine`. */
  start: number
  /** Buffer offset at or just after the end of the requested window. */
  end: number
}

export type CompletionCandidate = {
  text: string
  start: number
  end: number
}

export type FaceStyle = {
  fg?: string
  bg?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  family?: string
  height?: number
  heightScale?: number
  inherit?: FaceName[]
}

export type Theme = {
  name: string
  faces: Partial<Record<FaceName, FaceStyle>>
}

export type TableCellModel = {
  text: string
  title?: string
  face?: string
  value?: string | number | boolean
  bar?: number
  badge?: string
}

export type TableColumnModel = {
  key: string
  label: string
  align?: "left" | "right" | "center"
  width?: number
  minWidth?: number
  maxWidth?: number
  sortable?: boolean
  sortDirection?: "asc" | "desc"
}

export type TableRowModel = {
  id: string
  line: number
  selected?: boolean
  marked?: boolean
  depth?: number
  cells: Record<string, TableCellModel>
  actions?: Array<{ id: string; label: string; title?: string }>
}

export type TableSurfaceModel = {
  kind: "table"
  columns: TableColumnModel[]
  rows: TableRowModel[]
  emptyText?: string
}

// ── Web surface ────────────────────────────────────────────────────────────────

/**
 * A styled box in a web surface, addressed by `id` for click routing.
 *
 * This is a declarative subset of HTML rather than a raw markup string: modes describe
 * *what* to draw and the host decides how, which keeps plugins unable to inject scripts
 * or arbitrary DOM into the frame.
 */
export type WebNodeModel = {
  id?: string
  /**
   * Layout role. `row`/`column` are flex containers; the rest are leaves.
   *
   * `badge` is a pill-shaped label, for the short enumerated values -- a session state, a
   * variable's type, a verdict -- that read as noise inline but as structure when boxed.
   *
   * `image` draws the picture at `src`. The host accepts only `file:` and `data:` URLs,
   * so a surface cannot make the frame fetch anything over the network.
   */
  kind: "row" | "column" | "text" | "bar" | "badge" | "image"
  text?: string
  /** Picture location for `image`. `file:` or `data:` only; other schemes are dropped. */
  src?: string
  /** Theme face name, resolved by the host against the active theme. */
  face?: string
  /** 0..1 fill fraction, only meaningful for `bar`. */
  value?: number
  /**
   * Tree depth, rendered as leading space.
   *
   * Text renderings carry hierarchy in leading spaces, which a flex row collapses; a
   * variables or call-stack tree is unreadable without this.
   */
  indent?: number
  /**
   * Marks the row the buffer's point is on.
   *
   * A surface pane paints no caret, so without this the keyboard selection a mode
   * maintains would be invisible in the GUI.
   */
  selected?: boolean
  /** Emitted as a pane action when clicked, if the host supports mouse input. */
  action?: string
  title?: string
  children?: WebNodeModel[]
}

/**
 * A canvas drawing, expressed as an ordered list of primitives.
 *
 * Coordinates are fractions of the canvas box (0..1) so the host can size the canvas to
 * the pane without the mode knowing anything about pixels.
 */
export type CanvasShapeModel =
  | { kind: "rect"; x: number; y: number; width: number; height: number; face?: string; fill?: boolean }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; face?: string }
  | { kind: "text"; x: number; y: number; text: string; face?: string; align?: "left" | "center" | "right" }

export type CanvasSurfaceModel = {
  /** Drawing aspect ratio (width / height), used to size the canvas box. */
  aspect?: number
  shapes: CanvasShapeModel[]
}

/**
 * Rich pane content for hosts with a DOM, such as the Electron GUI.
 *
 * Like `TableSurfaceModel`, this never replaces the pane's `body` text: the body remains
 * the copy, search, and TUI rendering of the same information, and a host without
 * `webSurfaces` support simply ignores this field. That is what keeps every feature built
 * on it usable in the terminal.
 */
export type WebSurfaceModel = {
  kind: "web"
  nodes: WebNodeModel[]
  canvas?: CanvasSurfaceModel
}

export type PaneAction = {
  action: string
  payload?: Record<string, string | number | boolean>
}

export type ImenuIndexEntry = {
  name: string
  point: number
}

// ── Host / display state the kernel receives but does not compute ───────────

/** Viewport state a host hands to `clickWindow` so kernel can map cell→point. */
export type WindowClickState = {
  startLine: number
  gutterPrefixLen: number
}

// ── LSP surface kernel calls (subset of ../lsp/manager.LspManager) ──────────

/** The three calls editor.ts makes on `editor.lsp`. Narrowing the field to
 *  this would add noImplicitAny errors in plugins/display that read the wider
 *  LspManager surface, so the field keeps its concrete type until the slot
 *  moves off Editor entirely (lsp/ owns its state via WeakMap<Editor,…>). */
export interface KernelLsp {
  attachBuffer(buffer: BufferModel): void
  completionAtPoint(buffer: BufferModel): Promise<CompletionCandidate[]>
  diagnosticSpans(buffer: BufferModel): TextSpan[]
}

// ── Mode-system seam ────────────────────────────────────────────────────────

/** Shape of a major mode as far as kernel cares: a name, an optional keymap,
 *  and the per-mode behaviours kernel currently dispatches. */
export type ModeSpec = {
  name: string
  keymap?: Keymap
  indentLine?: (buffer: BufferModel) => void
  fontLock?: (buffer: BufferModel, range?: FontLockRange) => TextSpan[]
  displayFilter?: (buffer: BufferModel) => { text: string; map: (n: number) => number; unmap?: (n: number) => number } | null
  tableSurface?: (buffer: BufferModel) => TableSurfaceModel | null
  paneAction?: (buffer: BufferModel, action: PaneAction) => boolean | void
  mouseClick?: (buffer: BufferModel, point: number) => boolean | void
  completeAtPoint?: (buffer: BufferModel) => CompletionCandidate[]
  beginningOfDefun?: (buffer: BufferModel) => boolean | void
  endOfDefun?: (buffer: BufferModel) => boolean | void
  imenuIndex?: (buffer: BufferModel) => ImenuIndexEntry[]
}

export type PointKeymapSource = (buffer: BufferModel, point: number) => Keymap | null

const pointKeymapSources: PointKeymapSource[] = []

export function addPointKeymapSource(source: PointKeymapSource): () => void {
  pointKeymapSources.push(source)
  return () => {
    const index = pointKeymapSources.indexOf(source)
    if (index >= 0) pointKeymapSources.splice(index, 1)
  }
}

export function pointKeymaps(buffer: BufferModel, point: number): Keymap[] {
  const maps: Keymap[] = []
  for (const source of pointKeymapSources) {
    const keymap = source(buffer, point)
    if (keymap) maps.push(keymap)
  }
  return maps
}

export type MinorModeSpec = {
  name: string
  lighter?: string
  global?: boolean
  keymap?: Keymap
  // `editor` is the concrete Editor; typed loosely so this file stays acyclic with editor.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onEnable?: (editor: any, buffer: BufferModel | null) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onDisable?: (editor: any, buffer: BufferModel | null) => void
}

/** Late-bound mode/minor-mode/dired registry. modes/ self-wires at module
 *  load; the no-op default keeps a bare `new Editor()` usable for tests that
 *  don't touch mode dispatch. */
export interface KernelModeSystem {
  getMode(name: string): ModeSpec | undefined
  modeLineage(name: string): ModeSpec[]
  modeFeature<K extends keyof ModeSpec>(name: string, feature: K): NonNullable<ModeSpec[K]> | undefined
  enterMode(buffer: BufferModel, name: string): void
  getMinorMode(name: string): MinorModeSpec | undefined
  allMinorModes(): MinorModeSpec[]
  makeDirectoryBuffer?: (path: string) => Promise<BufferModel>
}

const noopModeSystem: KernelModeSystem = {
  getMode: () => undefined,
  modeLineage: () => [],
  modeFeature: () => undefined,
  enterMode: (buffer, name) => { buffer.mode = name },
  getMinorMode: () => undefined,
  allMinorModes: () => [],
}

export let modeSystem: KernelModeSystem = noopModeSystem

/** Merge — independent layers (mode.ts, minor-mode.ts, dired) each wire their slice. */
export function setModeSystem(impl: Partial<KernelModeSystem>): void {
  modeSystem = { ...modeSystem, ...impl }
}

// ── Display seam ────────────────────────────────────────────────────────────

/** Viewport math the kernel needs but display/ owns the visual-row-aware
 *  version of. Default handles the unweighted (TUI) case. */
export interface KernelDisplaySystem {
  syncViewportStartLine(startLine: number, cursorLine: number, lineBudget: number, visualRows?: readonly number[]): number
}

export let displaySystem: KernelDisplaySystem = {
  syncViewportStartLine: (startLine, cursorLine, lineBudget) => {
    if (cursorLine < startLine) return cursorLine
    if (cursorLine >= startLine + lineBudget) return Math.max(0, cursorLine - lineBudget + 1)
    return startLine
  },
}

export function setDisplaySystem(impl: Partial<KernelDisplaySystem>): void {
  displaySystem = { ...displaySystem, ...impl }
}
