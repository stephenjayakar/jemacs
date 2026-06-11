import type { BufferModel } from "./buffer"
import type { Editor } from "./editor"
import type { KeyEventLike } from "./keymap"
import type { RawPrefixShape } from "./prefix-argument"
import { registerCatalogEntry } from "../runtime/definitions"
import type { SourceLocation } from "../runtime/source"
import { captureCallerSource } from "../runtime/source"

export type CommandContext = {
  editor: Editor
  buffer: BufferModel
  args: string[]
  prefixArgument: number | null
  /** Raw prefix shape before collapsing to a single number.
   *  Use this when behavior depends on how the prefix was specified
   *  (plain C-u vs typed digits, bare M--, explicit zero, etc.). */
  rawPrefixShape: RawPrefixShape
  /** Key that triggered this command via dispatchKey; null when run programmatically.
   *  Prefer this over editor.lastKeyEvent, which a later key can overwrite mid-dispatch. */
  keyEvent: KeyEventLike | null
}

export type CommandFn = (ctx: CommandContext) => unknown | Promise<unknown>

export type CommandSpec = {
  name: string
  description?: string
  /** When true, command may be invoked interactively; use a string for `interactive` form specs. */
  interactive?: boolean | string
  fn: CommandFn
  /** First registered implementation (disk or initial load). */
  baselineFn?: CommandFn
  /** True when `fn` differs from baseline via eval-defun / eval. */
  patched?: boolean
  source?: SourceLocation
}

export class CommandRegistry {
  private commands = new Map<string, CommandSpec>()

  define(name: string, fn: CommandFn, options: Omit<CommandSpec, "name" | "fn"> = {}): void {
    const source = options.source ?? captureCallerSource(3)
    const existing = this.commands.get(name)
    if (!existing) {
      const spec = { name, fn, baselineFn: fn, patched: false, source, ...options }
      this.commands.set(name, spec)
      registerCatalogEntry({ kind: "command", name, source, doc: options.description, patched: false })
      return
    }
    existing.fn = fn
    existing.description = options.description ?? existing.description
    existing.interactive = options.interactive ?? existing.interactive
    if (source) existing.source = source
    if (!existing.patched) existing.baselineFn = fn
    registerCatalogEntry({ kind: "command", name, source: existing.source, doc: existing.description, patched: existing.patched })
  }

  patch(name: string, fn: CommandFn, source?: SourceLocation): void {
    const spec = this.commands.get(name)
    if (!spec) throw new Error(`Unknown command: ${name}`)
    if (!spec.baselineFn) spec.baselineFn = spec.fn
    spec.fn = fn
    spec.patched = true
    if (source) spec.source = source
    registerCatalogEntry({ kind: "command", name, source: spec.source, doc: spec.description, patched: true })
  }

  restore(name: string): boolean {
    const spec = this.commands.get(name)
    if (!spec?.patched || !spec.baselineFn) return false
    spec.fn = spec.baselineFn
    spec.patched = false
    registerCatalogEntry({ kind: "command", name, source: spec.source, doc: spec.description, patched: false })
    return true
  }

  restoreAll(): void {
    for (const name of this.names()) this.restore(name)
  }

  get(name: string): CommandSpec | undefined {
    return this.commands.get(name)
  }

  names(): string[] {
    return [...this.commands.keys()].sort()
  }

  entries(): CommandSpec[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
}
