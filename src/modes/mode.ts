import type { BufferModel } from "../kernel/buffer"
import { Keymap } from "../kernel/keymap"

export type FaceName = "default" | "keyword" | "string" | "comment" | "builtin" | "function" | "type" | "number" | "constant" | "directory" | "region" | "modeLine" | "minibuffer" | "error"

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

export type Mode = {
  name: string
  parent?: string
  commentStart?: string
  keymap?: Keymap
  hooks?: Array<(buffer: BufferModel) => void>
  onEnter?: (buffer: BufferModel) => void
  indentLine?: (buffer: BufferModel) => void
  fontLock?: (buffer: BufferModel) => TextSpan[]
  completeAtPoint?: (buffer: BufferModel) => CompletionCandidate[]
}

export const modes = new Map<string, Mode>()

export function defineMode(mode: Mode): Mode {
  const keymap = mode.keymap ?? new Keymap(`${mode.name}-map`)
  const installed = { ...mode, keymap }
  modes.set(installed.name, installed)
  return installed
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
  for (const mode of modeLineage(name)) {
    const value = mode[feature]
    if (value != null) return value as NonNullable<Mode[T]>
  }
  return undefined
}

export function enterMode(buffer: BufferModel, name: string): void {
  buffer.mode = name
  for (const mode of [...modeLineage(name)].reverse()) {
    mode.onEnter?.(buffer)
    for (const hook of mode.hooks ?? []) hook(buffer)
  }
}
