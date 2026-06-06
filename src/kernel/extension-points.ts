import type { BufferModel } from "./buffer"
import type { Keymap } from "./keymap"

/**
 * Kernel-owned structural types + the dependency-inversion seam that lets the
 * kernel stay independent of modes/, display/, themes/, lsp/ (ARCHITECTURE.md
 * 06-05 finding #2). Upper layers import these types from here; they install
 * behaviour via `setModeSystem` at boot. Until that wiring lands the
 * value-level coupling in editor.ts remains — see t-audit-1c671e26 sub-tasks.
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
 *  and the per-mode behaviours kernel currently dispatches (font-lock,
 *  indent, completion). `defgeneric` will eventually replace the latter. */
export type ModeSpec = {
  name: string
  keymap?: Keymap
  indentLine?: (buffer: BufferModel) => void
  fontLock?: (buffer: BufferModel) => TextSpan[]
  completeAtPoint?: (buffer: BufferModel) => CompletionCandidate[]
}

export type MinorModeSpec = {
  name: string
  lighter?: string
  global?: boolean
  keymap?: Keymap
}

/** Late-bound mode/minor-mode/dired registry. `installDefaultConfig` (or
 *  `lisp/loadup`) installs the real implementation; the no-op default keeps
 *  a bare `new Editor()` usable for tests that don't touch mode dispatch. */
export interface KernelModeSystem {
  getMode(name: string): ModeSpec | undefined
  modeLineage(name: string): ModeSpec[]
  enterMode(buffer: BufferModel, name: string): void
  getMinorMode(name: string): MinorModeSpec | undefined
  allMinorModes(): MinorModeSpec[]
  makeDirectoryBuffer?: (path: string) => Promise<BufferModel>
}

const noopModeSystem: KernelModeSystem = {
  getMode: () => undefined,
  modeLineage: () => [],
  enterMode: (buffer, name) => { buffer.mode = name },
  getMinorMode: () => undefined,
  allMinorModes: () => [],
}

export let modeSystem: KernelModeSystem = noopModeSystem

export function setModeSystem(impl: Partial<KernelModeSystem>): void {
  modeSystem = { ...noopModeSystem, ...impl }
}
