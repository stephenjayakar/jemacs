import type { CommandContext, CommandFn } from "../kernel/command"
import { registerCatalogEntry } from "./definitions"
import type { SourceLocation } from "./source"
import { captureCallerSource } from "./source"

export type CommandAdvice = {
  before?: (ctx: CommandContext) => void | Promise<void>
  after?: (ctx: CommandContext) => void | Promise<void>
  /** Wraps the advised command; call `inner` to invoke it (or skip it). */
  around?: (inner: CommandFn, ctx: CommandContext) => unknown | Promise<unknown>
  /** Replaces the advised command outright; original is restored on removeAdvice. */
  override?: CommandFn
}

type TrackedAdvice = {
  id: string
  commandName: string
  advice: CommandAdvice
  source?: SourceLocation
  patched?: boolean
  baseline?: CommandAdvice
}

const adviceByCommand = new Map<string, CommandAdvice[]>()
const tracked = new Map<string, TrackedAdvice>()

export function addAdvice(commandName: string, advice: CommandAdvice, source?: SourceLocation): string {
  const loc = source ?? captureCallerSource(3)
  const id = crypto.randomUUID()
  const entry: TrackedAdvice = { id, commandName, advice, source: loc, baseline: advice, patched: false }
  tracked.set(id, entry)
  const list = adviceByCommand.get(commandName) ?? []
  list.push(advice)
  adviceByCommand.set(commandName, list)
  registerCatalogEntry({ kind: "advice", name: commandName, detail: id, source: loc, doc: `Advice on ${commandName}` })
  return id
}

export function removeAdvice(id: string): boolean {
  const entry = tracked.get(id)
  if (!entry) return false
  const list = adviceByCommand.get(entry.commandName)
  if (list) {
    const index = list.indexOf(entry.advice)
    if (index >= 0) list.splice(index, 1)
    if (list.length === 0) adviceByCommand.delete(entry.commandName)
  }
  tracked.delete(id)
  return true
}

export function clearAdvice(commandName?: string): void {
  if (commandName) {
    adviceByCommand.delete(commandName)
    for (const [id, entry] of tracked) {
      if (entry.commandName === commandName) tracked.delete(id)
    }
    return
  }
  adviceByCommand.clear()
  tracked.clear()
}

export function restoreTrackedAdvice(id: string): boolean {
  const entry = tracked.get(id)
  if (!entry?.patched || !entry.baseline) return false
  const list = adviceByCommand.get(entry.commandName)
  if (list) {
    const index = list.indexOf(entry.advice)
    if (index >= 0) list[index] = entry.baseline
  }
  entry.advice = entry.baseline
  entry.patched = false
  registerCatalogEntry({ kind: "advice", name: entry.commandName, detail: id, source: entry.source, patched: false })
  return true
}

export function getTrackedAdvice(id: string): TrackedAdvice | undefined {
  return tracked.get(id)
}

export async function invokeWithAdvice(commandName: string, fn: CommandFn, ctx: CommandContext): Promise<unknown> {
  const list = adviceByCommand.get(commandName) ?? []
  // Compose nadvice-style: first-added advice is outermost, so fold from the
  // tail inward. before/after wrap as a pair, preserving the prior FIFO/LIFO order.
  let composed: CommandFn = fn
  for (let i = list.length - 1; i >= 0; i--) {
    const hook = list[i]
    const inner = composed
    if (hook.override) composed = hook.override
    else if (hook.around) composed = (c) => hook.around!(inner, c)
    else composed = async (c) => {
      await hook.before?.(c)
      const result = await inner(c)
      await hook.after?.(c)
      return result
    }
  }
  return composed(ctx)
}
