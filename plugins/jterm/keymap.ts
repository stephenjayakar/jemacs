import { Keymap, normalizeSequence } from "../../src/kernel/keymap"
import { getCustom } from "../../src/runtime/custom"

/** Char-mode keymap: every key resolves to jterm-send-raw, except C-c (the
 *  jterm escape prefix) and `jterm-keymap-exceptions`, which fall through to
 *  the editor like `vterm-keymap-exceptions` (C-x 0, M-x, ...). Installed as `editor.overridingTerminalLocalMap` so nothing
 *  falls through to global editing commands (C-k → kill-line, etc.). */
export class JTermRawMap extends Keymap {
  /** Char-mode belongs to one buffer, but `overridingTerminalLocalMap` is
   *  editor-global. The plugin sets this predicate to "the jterm buffer is the
   *  current buffer". When the user selects another window, every lookup misses
   *  and the normal mode/global maps apply to that other buffer. */
  guard: (() => boolean) | null = null
  constructor() {
    super("jterm-raw-map")
    this.bind("C-c C-c", "jterm-interrupt")
    this.bind("C-c C-k", "jterm-kill")
    this.bind("C-c C-s", "jterm-send-string")
    this.bind("C-c C-t", "jterm-copy-mode")
    this.bind("C-c C-y", "jterm-yank")
    this.bind("C-c C-l", "jterm-clear-scrollback")
    this.bind("C-c C-r", "jterm-reset-cursor-point")
    // Window switching must stay reachable in char-mode: a terminal never needs
    // C-tab, and losing it traps the user inside the jterm window.
    this.bind("C-tab", "other-window")
    for (const key of ["C-S-tab", "C-S-iso-lefttab", "C-iso-lefttab", "C-backtab"]) {
      this.bind(key, "previous-window-any-frame")
    }
  }
  override get(seq: string): string | undefined {
    if (this.guard && !this.guard()) return undefined
    const n = normalizeSequence(seq)
    const explicit = super.get(n)
    if (explicit) return explicit
    if (!n || n === "C-c") return undefined
    if (isException(n)) return undefined
    const toks = n.split(" ")
    // Single key, or C-c-prefixed (term-raw-escape-map's [t] binding) — falling
    // through would self-insert into a read-only buffer. Explicit bindings on
    // this map shadow the fallback.
    if (toks.length === 1 || (toks.length === 2 && toks[0] === "C-c")) return "jterm-send-raw"
    return undefined
  }
  override hasPrefix(seq: string): boolean {
    if (this.guard && !this.guard()) return false
    return normalizeSequence(seq) === "C-c" || super.hasPrefix(seq)
  }
}

/** True when SEQ's first key is in `jterm-keymap-exceptions`. Matching the
 *  first key keeps the whole C-x prefix (C-x 0, C-x b, ...) with the editor. */
function isException(seq: string): boolean {
  const exceptions = getCustom<string[]>("jterm-keymap-exceptions") ?? []
  const first = seq.split(" ")[0]
  return exceptions.some(key => normalizeSequence(key) === first)
}
