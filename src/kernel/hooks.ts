import type { BufferModel } from "./buffer"
import type { Editor } from "./editor"

export type HookContext = {
  editor: Editor
  buffer: BufferModel
}

export type HookFn = (ctx: HookContext) => void | Promise<void>

const registry = new Map<string, HookFn[]>()

export function modeHookName(mode: string): string {
  return `${mode}-mode-hook`
}

export function addHook(name: string, fn: HookFn): void {
  const list = registry.get(name) ?? []
  list.push(fn)
  registry.set(name, list)
}

export function removeHook(name: string, fn: HookFn): void {
  const list = registry.get(name)
  if (!list) return
  registry.set(name, list.filter(entry => entry !== fn))
}

export function getHooks(name: string): readonly HookFn[] {
  return registry.get(name) ?? []
}

export function clearHooks(name?: string): void {
  if (name) registry.delete(name)
  else registry.clear()
}

export async function runHooks(name: string, ctx: HookContext): Promise<void> {
  for (const fn of getHooks(name)) {
    await fn(ctx)
  }
}
