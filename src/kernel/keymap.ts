export type KeyToken = string

export type KeyEventLike = {
  name: string
  sequence?: string
  /** Full escape sequence from the terminal (when available). */
  raw?: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  super?: boolean
}

export type KeyLookupResult =
  | { status: "matched"; command: string; mapName: string }
  | { status: "pending"; mapName: string }
  | { status: "unmatched"; sequence: string }

export class Keymap {
  private bindings = new Map<string, string>()

  constructor(readonly name = "keymap") {}

  bind(sequence: string, commandName: string): void {
    const norm = normalizeSequence(sequence)
    this.bindings.set(norm, commandName)
    // Emacs ESC-is-Meta: any M-<k> binding is also reachable as `esc <k>`.
    const escForm = metaToEscPrefix(norm)
    if (escForm !== norm) this.bindings.set(escForm, commandName)
  }

  get(sequence: string): string | undefined {
    return this.bindings.get(normalizeSequence(sequence))
  }

  hasPrefix(sequence: string): boolean {
    const normalized = normalizeSequence(sequence)
    return [...this.bindings.keys()].some(k => k.startsWith(normalized + " "))
  }

  all(): Array<[string, string]> {
    return [...this.bindings.entries()].sort(([a], [b]) => a.localeCompare(b))
  }
}

export class KeymapStack {
  private pending: string[] = []

  constructor(private readonly maps: () => Array<{ name: string; keymap: Keymap }>) {}

  feed(key: KeyEventLike): KeyLookupResult {
    this.pending.push(keyToken(key))
    const sequence = this.pending.join(" ")
    const result = this.lookup(sequence)

    if (result.status === "matched") {
      this.pending = []
      return result
    }

    if (result.status === "pending") return result

    this.pending = []
    return { status: "unmatched", sequence }
  }

  lookup(sequence: string): KeyLookupResult {
    const normalized = normalizeSequence(sequence)

    for (const { name, keymap } of this.maps()) {
      const command = keymap.get(normalized)
      if (command) return { status: "matched", command, mapName: name }
      if (keymap.hasPrefix(normalized)) return { status: "pending", mapName: name }
    }

    return { status: "unmatched", sequence: normalized }
  }

  describe(sequence: string): { sequence: string; command: string; mapName: string } | null {
    const normalized = normalizeSequence(sequence)
    const result = this.lookup(normalized)
    if (result.status !== "matched") return null
    return { sequence: normalized, command: result.command, mapName: result.mapName }
  }

  clearPending(): void {
    this.pending = []
  }

  pendingSequence(): string {
    return this.pending.join(" ")
  }
}

export function normalizeSequence(sequence: string): string {
  return sequence.trim().split(/\s+/).filter(Boolean).map(normalizeToken).join(" ")
}

export function emacsKeyDescription(sequence: string): string {
  return normalizeSequence(sequence).split(" ").filter(Boolean).map(emacsKeyTokenDescription).join(" ")
}

function emacsKeyTokenDescription(token: string): string {
  const normalized = normalizeToken(token)
  const parts = normalized.split("-").filter(Boolean)
  const key = parts.pop() ?? ""
  const base = emacsBaseKeyDescription(key, parts.length > 0)
  return [...parts, base].join("-")
}

function emacsBaseKeyDescription(key: string, modified: boolean): string {
  switch (key) {
    case "enter": return modified ? "<return>" : "RET"
    case "space": return "SPC"
    case "backspace": return "DEL"
    case "tab": return modified ? "<tab>" : "TAB"
    case "esc": return "ESC"
    case "linefeed": return "LFD"
  }
  if (key.length === 1) return key
  return `<${key}>`
}

/** Rewrite each `M-<k>` token as `esc <k>` so ESC-prefix input reaches the same binding. */
export function metaToEscPrefix(normalized: string): string {
  return normalized
    .split(" ")
    .flatMap(tok => {
      if (tok.startsWith("M-")) return ["esc", tok.slice(2)]
      if (tok.startsWith("C-M-")) return ["esc", "C-" + tok.slice(4)]
      return [tok]
    })
    .join(" ")
}

export function normalizeToken(token: string): string {
  const raw = token.trim()
  if (!raw) return raw
  let parts: string[]
  let key: string
  if (raw.endsWith("-")) {
    key = "-"
    parts = raw.slice(0, -2).split("-").filter(Boolean)
  } else {
    parts = raw.split("-")
    key = normalizeKeyName(parts.pop() ?? "")
  }
  const lowerMods = new Set(parts.map(p => p.toLowerCase()))
  let hasCtrl = lowerMods.has("c") || lowerMods.has("ctrl")
  const hasMeta = lowerMods.has("m") || lowerMods.has("meta") || lowerMods.has("alt")
  const hasShift = parts.some(p => p === "S" || p.toLowerCase() === "shift")
  const hasSuper = parts.some(p => p === "s" || ["super", "cmd", "command"].includes(p.toLowerCase()))

  // Control-char ↔ named-key aliases. Terminals report one form, bindings use the
  // other; canonicalize so either spelling reaches the same binding.
  if (key === "linefeed") { key = "j"; hasCtrl = true }
  else if (hasCtrl && key === "m") { key = "enter"; hasCtrl = false }
  else if (hasCtrl && key === "i") { key = "tab"; hasCtrl = false }

  const ordered = [
    hasCtrl ? "C" : null,
    hasMeta ? "M" : null,
    hasShift ? "S" : null,
    hasSuper ? "s" : null,
  ].filter(Boolean)
  return [...ordered, key].join("-")
}

export function keyToken(key: KeyEventLike): string {
  const macOptionMeta = macOptionMetaKey(canonicalizeKeyEvent(key))
  if (macOptionMeta) return `M-${macOptionMeta}`

  // OpenTUI delivers ESC-prefixed punctuation as {name:"", sequence:"\x1b<char>", meta:false}.
  if (key.name === "" && key.sequence?.length === 2 && key.sequence[0] === "\x1b") {
    return keyToken({ ...key, name: key.sequence[1]!, sequence: key.sequence[1], meta: true })
  }

  const canon = canonicalizeKeyEvent(key)
  const base = normalizeKeyName(canon.name === "return" ? "enter" : canon.name === "escape" ? "esc" : canon.name === "space" && canon.sequence === " " ? "space" : canon.name)
  const shiftedGlyph = base.length === 1 && !/[a-z0-9]/.test(base)
  const mods = [
    canon.ctrl ? "C" : null,
    canon.meta ? "M" : null,
    canon.shift && !shiftedGlyph ? "S" : null,
    canon.super ? "s" : null,
  ].filter(Boolean)
  return [...mods, base].join("-")
}

export function isMetaKey(key: KeyEventLike): boolean {
  return key.meta === true || macOptionMetaKey(key) != null
}

export function isPrintable(key: KeyEventLike): boolean {
  return !key.ctrl && !key.super && !isMetaKey(key) && typeof key.sequence === "string" && key.sequence.length > 0 && (key.name.length === 1 || key.sequence === " ")
}

/** Emacs key-name spellings → canonical name used in bindings. */
const KEY_NAME_ALIASES: Record<string, string> = {
  return: "enter",
  ret: "enter",
  escape: "esc",
  spc: "space",
  del: "backspace",
  lfd: "linefeed",
}

function normalizeKeyName(name: string): string {
  const lower = name.toLowerCase().replace(/^<(.+)>$/, "$1")
  return KEY_NAME_ALIASES[lower] ?? lower
}

/** Kitty CSI-u tab encoding: ESC [ 9 ; MOD u or ESC [ 57346 ; MOD u */
function kittyTabModifiers(raw: string): { ctrl: boolean; shift: boolean } | null {
  const match = raw.match(/^\x1b\[(?:9|57346);(\d+)u$/)
  if (!match) return null
  const mask = Number.parseInt(match[1]!, 10)
  if (Number.isNaN(mask) || mask <= 1) return { ctrl: false, shift: false }
  const mod = mask - 1
  return { ctrl: !!(mod & 4), shift: !!(mod & 1) }
}

function rawLooksLikeTab(raw: string): boolean {
  return raw.includes("\t")
    || /^\x1b\[(?:9|57346);/.test(raw)
    || /^\x1b\[1;\d+;9u$/.test(raw)
    || raw === "\x1b[Z"
}

/** Normalize terminal-specific Tab encodings (Emacs `<backtab>`, `<C-tab>`, Kitty CSI-u, etc.). */
export function canonicalizeKeyEvent(key: KeyEventLike): KeyEventLike {
  let name = normalizeKeyName(key.name)
  let ctrl = key.ctrl === true
  let shift = key.shift === true
  const seq = key.sequence
  const raw = key.raw ?? seq ?? ""

  const tabMods = kittyTabModifiers(raw)
  if (tabMods) {
    name = "tab"
    ctrl = tabMods.ctrl
    shift = tabMods.shift
  }

  if (seq === "\t" || seq === "\x09") name = "tab"

  // Terminals encode C-h as ASCII BS (0x08), while a real Backspace key should
  // arrive as DEL (0x7f). Keep C-h reachable as the help prefix.
  if ((seq === "\x08" || raw === "\x08") && name === "backspace") {
    name = "h"
    ctrl = true
  }

  // Terminals report C-j as the bare key name "linefeed" with no ctrl modifier;
  // canonicalize so bindings written as "C-j" are reachable from the event side.
  if (name === "linefeed") {
    name = "j"
    ctrl = true
  }

  // Legacy/xterm: Ctrl+Tab is byte 9, mis-parsed as name "i" (same as C-i).
  if (ctrl && name === "i" && rawLooksLikeTab(raw)) {
    name = "tab"
  }

  if (name === "backtab" || name === "iso-lefttab" || name === "lefttab") {
    name = "tab"
    shift = true
  }

  if (name === "tab" && (raw === "\x1b[Z" || raw.includes(";2u") || raw.includes("1;2;9"))) {
    shift = true
  }

  return {
    ...key,
    name,
    ctrl: ctrl || undefined,
    shift: shift || undefined,
  }
}

function macOptionMetaKey(key: KeyEventLike): string | null {
  const value = key.sequence ?? key.name
  switch (value) {
    case "∫":
      return "b"
    case "ƒ":
      return "f"
    case "≈":
      return "x"
    case "≥":
      return "."
    case "≤":
      return ","
    case "√":
      return "v"
    default:
      return null
  }
}
