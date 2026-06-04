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
  | { status: "unmatched" }

export class Keymap {
  private bindings = new Map<string, string>()
  private pending: string[] = []

  constructor(readonly name = "keymap") {}

  bind(sequence: string, commandName: string): void {
    this.bindings.set(normalizeSequence(sequence), commandName)
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

  feed(key: KeyEventLike): { status: "matched"; command: string } | { status: "pending" } | { status: "unmatched" } {
    const token = keyToken(key)
    this.pending.push(token)
    const seq = this.pending.join(" ")

    const exact = this.bindings.get(seq)
    if (exact) {
      this.pending = []
      return { status: "matched", command: exact }
    }

    if (this.hasPrefix(seq)) return { status: "pending" }

    this.pending = []
    return { status: "unmatched" }
  }

  clearPending(): void {
    this.pending = []
  }

  pendingSequence(): string {
    return this.pending.join(" ")
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
    return result
  }

  lookup(sequence: string): KeyLookupResult {
    const normalized = normalizeSequence(sequence)
    let pendingMap: string | null = null

    for (const { name, keymap } of this.maps()) {
      const command = keymap.get(normalized)
      if (command) return { status: "matched", command, mapName: name }
      if (!pendingMap && keymap.hasPrefix(normalized)) pendingMap = name
    }

    return pendingMap ? { status: "pending", mapName: pendingMap } : { status: "unmatched" }
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

export function normalizeToken(token: string): string {
  const raw = token.trim()
  if (!raw) return raw
  const parts = raw.split("-")
  const key = normalizeKeyName(parts.pop() ?? "")
  const lowerMods = new Set(parts.map(p => p.toLowerCase()))
  const hasShift = parts.some(p => p === "S" || p.toLowerCase() === "shift")
  const hasSuper = parts.some(p => p === "s" || ["super", "cmd", "command"].includes(p.toLowerCase()))
  const ordered = [
    lowerMods.has("c") || lowerMods.has("ctrl") ? "C" : null,
    lowerMods.has("m") || lowerMods.has("meta") || lowerMods.has("alt") ? "M" : null,
    hasShift ? "S" : null,
    hasSuper ? "s" : null,
  ].filter(Boolean)
  return [...ordered, key].join("-")
}

export function keyToken(key: KeyEventLike): string {
  const macOptionMeta = macOptionMetaKey(canonicalizeKeyEvent(key))
  if (macOptionMeta) return `M-${macOptionMeta}`

  const canon = canonicalizeKeyEvent(key)
  const base = normalizeKeyName(canon.name === "return" ? "enter" : canon.name === "escape" ? "esc" : canon.name === "space" && canon.sequence === " " ? "space" : canon.name)
  const mods = [
    canon.ctrl ? "C" : null,
    canon.meta ? "M" : null,
    canon.shift ? "S" : null,
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

function normalizeKeyName(name: string): string {
  return name.toLowerCase().replace(/^<(.+)>$/, "$1")
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
    default:
      return null
  }
}
