import type { KeyEventLike } from "../kernel/keymap"
import type { WindowClickState } from "./click-to-point"
import type { TextSpan } from "../modes/mode"
import type { TableSurfaceModel, WebSurfaceModel } from "../kernel/extension-points"
import type { Theme } from "./theme"
import type { ThemedText } from "./themed-text"
import type { TerminalSurfaceModel } from "./terminal-surface"
import type { ViewportSize } from "./viewport"

export type DisplayChunk = ThemedText
export type { CanvasShapeModel, CanvasSurfaceModel, TableSurfaceModel, WebNodeModel, WebSurfaceModel } from "../kernel/extension-points"

export type WindowPaneModel = {
  id: string
  bufferId: string
  selected: boolean
  dedicated: boolean
  body: DisplayChunk
  /** Set for hosts with real font metrics (`perFaceFonts`): the caret position
   *  as a `body` row index plus a character offset into that row, in place of
   *  the █ glyph char-grid hosts draw inline. A block glyph mis-sizes itself
   *  inside height-scaled or variable-pitch faces; a positioned caret does not.
   *  `shape` mirrors the `cursor-type` custom ("box" draws a block). */
  cursor?: { row: number; colOffset: number; shape?: "bar" | "box" }
  /** Optional host-renderable terminal grid. `body` remains the copy-mode/fallback text. */
  terminalSurface?: TerminalSurfaceModel
  /** Optional host-renderable table. `body` remains the copy/search/TUI fallback text. */
  tableSurface?: TableSurfaceModel
  /** Optional host-renderable DOM/canvas pane. `body` remains the copy/search/TUI fallback text. */
  webSurface?: WebSurfaceModel
  /** Optional rows rendered below body and above modeline. Not part of body hit-testing. */
  footer?: DisplayChunk
  modeline: DisplayChunk
  /** Maps body cell coordinates to buffer point (see `pointFromWindowClick`). */
  clickState: WindowClickState
  bodyLineBudget: number
  /** Full buffer text for native editor sync (OpenTUI Textarea path). */
  syncText: string
  syncPoint: number
  /** Buffer-absolute spans for Textarea font-lock / region highlights. */
  syncSpans: TextSpan[]
  /** Per-buffer text scale factor (1 = default; from `text-scale-mode-amount`). */
  textScale: number
}

export type ChildFrameModel = {
  id: string
  parentFrameId: string
  pane: WindowPaneModel
  top: number
  left: number
  width: number
  height: number
}

export type WindowSplitModel = {
  kind: "split"
  direction: "horizontal" | "vertical"
  firstRatio?: number
  first: WindowDisplayNode
  second: WindowDisplayNode
}

export type WindowLeafModel = {
  kind: "leaf"
  pane: WindowPaneModel
  lineBudget: number
}

export type WindowDisplayNode = WindowLeafModel | WindowSplitModel

export type DisplayModel = {
  title: DisplayChunk
  /** Tab-bar row above the window stack. Absent when the bar is hidden. */
  tabBar?: DisplayChunk
  windows: WindowDisplayNode
  childFrames: ChildFrameModel[]
  minibufferCompletions: DisplayChunk
  minibufferCompletionLines: number
  minibuffer: DisplayChunk
  echo: DisplayChunk
  theme: Theme
  viewport: ViewportSize
  hostLabel: string
}

export type HostCapabilities = {
  unit: "cells" | "pixels"
  mouse: boolean
  clipboard: boolean
  osc52: boolean
  /** When true, the host applies per-chunk font-family and height (Electron only). */
  perFaceFonts?: boolean
  /** When true, the host has a terminal-grid path instead of only plain text. */
  terminalSurfaces?: boolean
  /** When true, terminal panes can render raw PTY streams and only need surface metadata. */
  terminalRawStreams?: boolean
  /** When true, the host can render rich table/list panes. */
  richTables?: boolean
  /** When true, the host can render declarative HTML/canvas panes (DOM hosts only). */
  webSurfaces?: boolean
}

export type TerminalData = {
  bufferId: string
  data: string
}

export type NormalizedInput =
  | { type: "key"; key: KeyEventLike }
  | { type: "paste"; text: string }
  /** `drag: true` means the button is still held and point should extend the
   *  region from the mark set on press. */
  | { type: "mouse"; windowId: string; row: number; col: number; button?: number; drag?: boolean }
  | { type: "wheel"; windowId: string; lines: number }
  /** Click on the tab bar, as a character column into its rendered text. */
  | { type: "tab-bar"; col: number }
  | { type: "pane-action"; windowId: string; action: string; payload?: Record<string, string | number | boolean> }

/** `frameId` is set by multi-frame hosts so input is routed to the originating frame. */
export type InputHandler = (input: NormalizedInput, frameId?: string) => void | Promise<void>
export type ResizeHandler = (viewport: ViewportSize) => void

export interface UiHost {
  /** Human-readable host name for the title bar / `hostLabel`. */
  readonly label: string
  readonly capabilities: HostCapabilities
  start(): Promise<void>
  destroy(): void
  present(model: DisplayModel): void
  /**
   * Paint every editor frame, for hosts that show more than one at a time.
   *
   * Implementing this *replaces* `present` in the redisplay loop rather than
   * supplementing it, so a frame is built and painted exactly once per redisplay.
   * `render` is supplied by the binding so every frame is built with the host's
   * capabilities; hosts must not build models themselves.
   */
  syncFrames?(
    frames: ReadonlyArray<{ id: string; name: string }>,
    render: (frameId: string) => DisplayModel,
  ): void
  sendTerminalData?(payload: TerminalData): void
  getViewport(): ViewportSize
  onInput(handler: InputHandler): void
  onResize(handler: ResizeHandler): void
}
