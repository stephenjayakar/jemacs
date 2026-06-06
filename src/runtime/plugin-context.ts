import type { Editor } from "../kernel/editor"
import type { CommandFn } from "../kernel/command"
import { addHook, removeHook, type HookFn } from "../kernel/hooks"
import { addAdvice, removeAdvice, type CommandAdvice } from "./advice"
import { applyKeyBinding, getKeyBinding } from "./key-registry"
import { defineMinorMode, getMinorMode, type MinorMode } from "../modes/minor-mode"

type Disposer = () => void

/**
 * Per-plugin registration surface. Thin wrappers over editor.command /
 * defineKey / addHook / addAdvice that also record an undo thunk so
 * dispose() can tear the plugin down cleanly before a reload.
 */
export type PluginContext = {
  command(name: string, fn: CommandFn, doc?: string): void
  key(map: string, seq: string, cmd: string): void
  hook(name: string, fn: HookFn): void
  advice(cmd: string, advice: CommandAdvice): string
  minorMode(spec: MinorMode): MinorMode
  onDispose(fn: Disposer): void
  dispose(): void
}

export function createPluginContext(editor: Editor): PluginContext {
  const disposers: Disposer[] = []
  return {
    command(name, fn, doc) {
      // CommandRegistry.define mutates the existing spec in place, so capture
      // the prior fn *before* re-defining or we'd close over the new one.
      const prior = editor.commands.get(name)
      const priorFn = prior?.fn
      const priorDoc = prior?.description
      editor.command(name, fn, doc)
      if (priorFn) disposers.push(() => editor.command(name, priorFn, priorDoc))
    },
    key(map, seq, cmd) {
      const prior = getKeyBinding(map, seq)?.command
      applyKeyBinding(editor, map, seq, cmd)
      // Keymap has no unbind; restore the previous binding if one existed.
      if (prior) disposers.push(() => applyKeyBinding(editor, map, seq, prior))
    },
    hook(name, fn) {
      addHook(name, fn)
      disposers.push(() => removeHook(name, fn))
    },
    advice(cmd, adv) {
      const id = addAdvice(cmd, adv)
      disposers.push(() => removeAdvice(id))
      return id
    },
    minorMode(spec) {
      const prior = getMinorMode(spec.name)
      const installed = defineMinorMode(spec)
      if (prior) disposers.push(() => defineMinorMode(prior))
      return installed
    },
    onDispose(fn) {
      disposers.push(fn)
    },
    dispose() {
      while (disposers.length) {
        try { disposers.pop()!() } catch { /* keep tearing down */ }
      }
    },
  }
}

/** Per-editor registry so boot-time installs (lisp/, plugins/builtin) and
 *  path-based reloads (Evaluator.loadPlugin) share the same disposal map
 *  *for that editor*. A second Editor in the process must not dispose the
 *  first's contexts. */
const contexts = new WeakMap<Editor, Map<string, PluginContext>>()

function mapFor(editor: Editor): Map<string, PluginContext> {
  let m = contexts.get(editor)
  if (!m) { m = new Map(); contexts.set(editor, m) }
  return m
}

/** Dispose any prior context registered under `key` for this editor, create
 *  and register a fresh one. Used by both the boot path and hot reload. */
export function trackedContext(editor: Editor, key: string): PluginContext {
  const m = mapFor(editor)
  m.get(key)?.dispose()
  const ctx = createPluginContext(editor)
  m.set(key, ctx)
  return ctx
}

export function getPluginContext(editor: Editor, key: string): PluginContext | undefined {
  return contexts.get(editor)?.get(key)
}

/** Dispose every tracked context for `editor` (called from quit()). */
export function disposeAllContexts(editor: Editor): void {
  const m = contexts.get(editor)
  if (!m) return
  for (const ctx of m.values()) ctx.dispose()
  contexts.delete(editor)
}
