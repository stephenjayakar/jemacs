import type { BufferModel } from "../kernel/buffer"
import type { FaceStyle } from "../display/theme-types"
import { Keymap } from "../kernel/keymap"
import { modeHookName, addHook, removeHook, type HookFn } from "../kernel/hooks"
import { registerCatalogEntry } from "../runtime/definitions"
import { defmethod, getGeneric, removeMethod } from "../runtime/generic"
import type { SourceLocation } from "../runtime/source"
import { captureCallerSource } from "../runtime/source"

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

export type TextSpan = {
  start: number
  end: number
  face: FaceName
  style?: FaceStyle
}

export type FontLockRange = {
  startLine: number
  endLine: number
  start: number
  end: number
}

export type CompletionCandidate = {
  text: string
  start: number
  end: number
}

export type Mode = {
  name: string
  parent?: string
  commentStart?: string
  keymap?: Keymap
  hooks?: Array<(buffer: BufferModel) => void>
  onEnter?: (buffer: BufferModel) => void
  indentLine?: (buffer: BufferModel) => void
  fontLock?: (buffer: BufferModel, range?: FontLockRange) => TextSpan[]
  beginningOfDefun?: (buffer: BufferModel) => boolean | void
  endOfDefun?: (buffer: BufferModel) => boolean | void
  /** Selective-display: alternate body text + buffer→display offset map. Return null for identity. */
  displayFilter?: (buffer: BufferModel) => { text: string; map: (n: number) => number; unmap?: (n: number) => number } | null
  mouseClick?: (buffer: BufferModel, point: number) => boolean | void
  completeAtPoint?: (buffer: BufferModel) => CompletionCandidate[]
}

export const modes = new Map<string, Mode>()

/** Per-mode behaviour fields that dispatch via `defgeneric`. `defineMode`
 *  registers them with `defmethod`; `modeFeature` reads the same table, so a
 *  third-party `defmethod` and a `Mode.field` resolve identically. */
const MODE_GENERICS = {
  indentLine: "indent-line",
  completeAtPoint: "complete-at-point",
  fontLock: "font-lock",
  displayFilter: "display-filter",
  mouseClick: "mouse-click",
  beginningOfDefun: "beginning-of-defun-function",
  endOfDefun: "end-of-defun-function",
} as const
type ModeGenericField = keyof typeof MODE_GENERICS

const modeBaselines = new Map<string, Mode>()
const modePatched = new Set<string>()
const modeHookFns = new Map<string, HookFn[]>()

export function defineMode(mode: Mode, source?: SourceLocation): Mode {
  const loc = source ?? captureCallerSource(3)
  const keymap = mode.keymap ?? new Keymap(`${mode.name}-map`)
  const installed = { ...mode, keymap }
  const existing = modes.get(installed.name)
  if (!existing) modeBaselines.set(installed.name, installed)
  else if (!modePatched.has(installed.name)) modeBaselines.set(installed.name, installed)
  modes.set(installed.name, installed)
  modePatched.delete(installed.name)
  syncModeMethods(installed, loc)
  registerCatalogEntry({ kind: "mode", name: installed.name, source: loc, doc: installed.parent ? `Child of ${installed.parent}` : undefined })
  const hookName = modeHookName(installed.name)
  for (const fn of modeHookFns.get(installed.name) ?? []) removeHook(hookName, fn)
  modeHookFns.delete(installed.name)
  if (mode.hooks?.length) {
    const fns: HookFn[] = []
    for (const hook of mode.hooks) {
      const fn: HookFn = ({ buffer }) => hook(buffer)
      addHook(hookName, fn)
      fns.push(fn)
    }
    modeHookFns.set(installed.name, fns)
  }
  return installed
}

function syncModeMethods(mode: Mode, source?: SourceLocation): void {
  for (const field of Object.keys(MODE_GENERICS) as ModeGenericField[]) {
    const generic = MODE_GENERICS[field]
    const fn = mode[field]
    if (fn) defmethod(generic, mode.name, fn, source)
    else removeMethod(generic, mode.name)
  }
}

export function markModePatched(name: string): void {
  modePatched.add(name)
  registerCatalogEntry({ kind: "mode", name, patched: true })
}

export function restoreMode(name: string): boolean {
  const baseline = modeBaselines.get(name)
  if (!baseline || !modePatched.has(name)) return false
  const restored = { ...baseline, keymap: baseline.keymap ?? new Keymap(`${name}-map`) }
  modes.set(name, restored)
  modePatched.delete(name)
  syncModeMethods(restored)
  registerCatalogEntry({ kind: "mode", name, patched: false })
  return true
}

export function getMode(name: string): Mode | undefined {
  return modes.get(name)
}

export function modeLineage(name: string): Mode[] {
  const lineage: Mode[] = []
  const seen = new Set<string>()
  let current = getMode(name)

  while (current && !seen.has(current.name)) {
    lineage.push(current)
    seen.add(current.name)
    current = current.parent ? getMode(current.parent) : undefined
  }

  return lineage
}

export function modeFeature<T extends keyof Mode>(name: string, feature: T): NonNullable<Mode[T]> | undefined {
  const generic = MODE_GENERICS[feature as ModeGenericField]
  const methods = generic ? getGeneric(generic)?.methods() : undefined
  for (const mode of modeLineage(name)) {
    const value = methods ? methods.get(mode.name) : mode[feature]
    if (value != null) return value as NonNullable<Mode[T]>
  }
  return undefined
}

export function enterMode(buffer: BufferModel, name: string): void {
  buffer.mode = name
  for (const mode of [...modeLineage(name)].reverse()) {
    mode.onEnter?.(buffer)
  }
}

// Self-wire the kernel seam so importing modes/ is all it takes for editor.ts
// mode dispatch to work — no explicit boot call needed.
import { setModeSystem } from "../kernel/extension-points"
setModeSystem({ getMode, modeLineage, modeFeature, enterMode })
