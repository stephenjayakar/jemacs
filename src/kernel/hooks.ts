import type { BufferModel } from "./buffer"
import type { Editor } from "./editor"
import { registerCatalogEntry } from "../runtime/definitions"
import type { SourceLocation } from "../runtime/source"
import { captureCallerSource } from "../runtime/source"

export type HookContext = {
  editor: Editor
  buffer: BufferModel
}

export type HookFn = (ctx: HookContext) => void | Promise<void>

type TrackedHook = {
  id: string
  name: string
  fn: HookFn
  source?: SourceLocation
  patched?: boolean
  baselineFn?: HookFn
}

const registry = new Map<string, HookFn[]>()
const tracked = new Map<string, TrackedHook>()

export function modeHookName(mode: string): string {
  return `${mode}-mode-hook`
}

export function addHook(name: string, fn: HookFn, source?: SourceLocation): void {
  const loc = source ?? captureCallerSource(3)
  const id = crypto.randomUUID()
  const entry: TrackedHook = { id, name, fn, source: loc, patched: false, baselineFn: fn }
  tracked.set(id, entry)
  const list = registry.get(name) ?? []
  list.push(fn)
  registry.set(name, list)
  registerCatalogEntry({ kind: "hook", name, detail: id, source: loc, doc: `Hook on ${name}` })
}

export function removeHook(name: string, fn: HookFn): void {
  const list = registry.get(name)
  if (!list) return
  registry.set(name, list.filter(entry => entry !== fn))
  for (const [id, entry] of tracked) {
    if (entry.name === name && entry.fn === fn) tracked.delete(id)
  }
}

export function removeTrackedHook(id: string): boolean {
  const entry = tracked.get(id)
  if (!entry) return false
  const list = registry.get(entry.name)
  if (list) registry.set(entry.name, list.filter(fn => fn !== entry.fn))
  tracked.delete(id)
  return true
}

export function getHooks(name: string): readonly HookFn[] {
  return registry.get(name) ?? []
}

export function getTrackedHook(id: string): TrackedHook | undefined {
  return tracked.get(id)
}

export function listTrackedHooks(name?: string): TrackedHook[] {
  const entries = [...tracked.values()]
  return name ? entries.filter(e => e.name === name) : entries
}

export function markHookPatched(id: string, fn: HookFn, baselineFn: HookFn): void {
  const entry = tracked.get(id)
  if (!entry) return
  const list = registry.get(entry.name)
  if (list) {
    const index = list.indexOf(entry.fn)
    if (index >= 0) list[index] = fn
  }
  entry.fn = fn
  entry.baselineFn = baselineFn
  entry.patched = true
  registerCatalogEntry({ kind: "hook", name: entry.name, detail: id, source: entry.source, patched: true })
}

export function restoreTrackedHook(id: string): boolean {
  const entry = tracked.get(id)
  if (!entry?.patched || !entry.baselineFn) return false
  const list = registry.get(entry.name)
  if (list) {
    const index = list.indexOf(entry.fn)
    if (index >= 0) list[index] = entry.baselineFn
  }
  entry.fn = entry.baselineFn
  entry.patched = false
  registerCatalogEntry({ kind: "hook", name: entry.name, detail: id, source: entry.source, patched: false })
  return true
}

export function clearHooks(name?: string): void {
  if (name) {
    registry.delete(name)
    for (const [id, entry] of tracked) {
      if (entry.name === name) tracked.delete(id)
    }
    return
  }
  registry.clear()
  tracked.clear()
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return !!value && typeof (value as { then?: unknown }).then === "function"
}

function reportHookError(name: string, ctx: HookContext, err: unknown): void {
  // Emacs run-hooks + condition-case semantics: a failing hook is reported
  // and skipped so the remaining hooks (and the caller) still run.
  const msg = err instanceof Error ? err.message : String(err)
  ctx.editor.message(`Error in ${name}: ${msg}`)
}

async function runHooksAfterAsync(
  pending: PromiseLike<void>,
  name: string,
  ctx: HookContext,
  hooks: readonly HookFn[],
  start: number,
): Promise<void> {
  try {
    await pending
  } catch (err) {
    reportHookError(name, ctx, err)
  }
  for (let i = start; i < hooks.length; i++) {
    try {
      await hooks[i]!(ctx)
    } catch (err) {
      reportHookError(name, ctx, err)
    }
  }
}

export function runHooksMaybeAsync(name: string, ctx: HookContext): void | Promise<void> {
  const hooks = getHooks(name)
  for (let i = 0; i < hooks.length; i++) {
    try {
      const result = hooks[i]!(ctx)
      if (isPromiseLike(result)) return runHooksAfterAsync(result, name, ctx, hooks, i + 1)
    } catch (err) {
      reportHookError(name, ctx, err)
    }
  }
}

export async function runHooks(name: string, ctx: HookContext): Promise<void> {
  await runHooksMaybeAsync(name, ctx)
}
