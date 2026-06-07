import { Keymap, normalizeSequence } from "../../src/kernel/keymap"

/** Char-mode keymap: every key resolves to jterm-send-raw. C-c is the only
 *  prefix escape. Installed as `editor.overridingTerminalLocalMap` so nothing
 *  falls through to global editing commands (C-k → kill-line, etc.). */
export class JTermRawMap extends Keymap {
  constructor() {
    super("jterm-raw-map")
    this.bind("C-c C-c", "jterm-interrupt")
    this.bind("C-c C-k", "jterm-kill")
    this.bind("C-c C-s", "jterm-send-string")
    this.bind("C-c C-j", "jterm-copy-mode")
    this.bind("C-c C-w", "jterm-copy-mode")
    this.bind("C-c C-y", "jterm-yank")
    this.bind("C-c C-l", "jterm-clear")
    this.bind("C-c C-r", "jterm-reset")
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
    if (toks.length === 1 || (toks.length === 2 && toks[0] === "C-c")) return "jterm-send-raw"
    return undefined
  }
  override hasPrefix(seq: string): boolean {
    return normalizeSequence(seq) === "C-c" || super.hasPrefix(seq)
  }
}
