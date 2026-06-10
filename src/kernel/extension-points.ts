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
  | "directory"
  | "region"
  | "isearch"
  | "lazyHighlight"
  | "modeLine"
  | "modeLineInactive"
  | "minibuffer"
  | "minibufferPrompt"
  | "title"
  | "error"
  | "lineNumber"
  | "lineNumberCurrent"

export type TextSpan = {
  start: number
  end: number
  face: FaceName
  style?: FaceStyle
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
  fontLock?: (buffer: BufferModel) => TextSpan[]
  completeAtPoint?: (buffer: BufferModel) => CompletionCandidate[]
  beginningOfDefun?: (buffer: BufferModel) => boolean | void
  endOfDefun?: (buffer: BufferModel) => boolean | void
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
