import type { KeyEventLike } from "../kernel/keymap"
import type { WindowClickState } from "./click-to-point"
import type { TextSpan } from "../modes/mode"
import type { Theme } from "./theme"
import type { ThemedText } from "./themed-text"
import type { TerminalSurfaceModel } from "./terminal-surface"
import type { ViewportSize } from "./viewport"

export type DisplayChunk = ThemedText

export type WindowPaneModel = {
  id: string
  bufferId: string
  selected: boolean
  dedicated: boolean
  body: DisplayChunk
  /** Optional host-renderable Markdown body. `body` remains the plain fallback. */
  markdownSurface?: MarkdownSurfaceModel
  /** Optional host-renderable terminal grid. `body` remains the copy-mode/fallback text. */
  terminalSurface?: TerminalSurfaceModel
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

export type MarkdownSurfaceModel = {
  kind: "markdown"
  content: string
  startLine: number
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
  windows: WindowDisplayNode
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
}

export type TerminalData = {
  bufferId: string
  data: string
}

export type NormalizedInput =
  | { type: "key"; key: KeyEventLike }
  | { type: "paste"; text: string }
  | { type: "mouse"; windowId: string; row: number; col: number; button?: number }

export type InputHandler = (input: NormalizedInput) => void | Promise<void>
export type ResizeHandler = (viewport: ViewportSize) => void

export interface UiHost {
  /** Human-readable host name for the title bar / `hostLabel`. */
  readonly label: string
  readonly capabilities: HostCapabilities
  start(): Promise<void>
  destroy(): void
  present(model: DisplayModel): void
  sendTerminalData?(payload: TerminalData): void
  getViewport(): ViewportSize
  onInput(handler: InputHandler): void
  onResize(handler: ResizeHandler): void
}
