import { Keymap, normalizeSequence } from "../../src/kernel/keymap"

/** Char-mode keymap: every key resolves to tui-term-send-raw. C-c is the only
 *  prefix escape. Installed as `editor.overridingTerminalLocalMap` so nothing
 *  falls through to global editing commands (C-k → kill-line, etc.). */
export class TuiTermRawMap extends Keymap {
  constructor() {
    super("tui-term-raw-map")
    this.bind("C-c C-c", "tui-term-interrupt")
    this.bind("C-c C-k", "tui-term-kill")
    this.bind("C-c C-s", "tui-term-send-string")
    this.bind("C-c C-j", "tui-term-copy-mode")
    this.bind("C-c C-w", "tui-term-copy-mode")
    this.bind("C-c C-y", "tui-term-yank")
    this.bind("C-c C-l", "tui-term-clear")
    this.bind("C-c C-r", "tui-term-reset")
  }
  override get(seq: string): string | undefined {
    const n = normalizeSequence(seq)
    const explicit = super.get(n)
    if (explicit) return explicit
    if (!n || n === "C-c") return undefined
    const toks = n.split(" ")
    // Single key, or C-c-prefixed (term-raw-escape-map's [t] binding) — falling
    // through would self-insert into a read-only buffer. Explicit bindings on
    // this map shadow the fallback.
    if (toks.length === 1 || (toks.length === 2 && toks[0] === "C-c")) return "tui-term-send-raw"
    return undefined
  }
  override hasPrefix(seq: string): boolean {
    return normalizeSequence(seq) === "C-c" || super.hasPrefix(seq)
  }
}
