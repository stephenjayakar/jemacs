import type { KeyEventLike } from "../kernel/keymap"

export type DomKeyPlatform = "mac" | "other"

/** Testable platform split: Option/Alt → Meta (M-), Command/Win → Super (s-). */
export function domKeyPlatform(userAgent = ""): DomKeyPlatform {
  return /Mac|iPhone|iPod|iPad/i.test(userAgent) ? "mac" : "other"
}

export function domKeyName(key: string): string {
  if (key === "Enter") return "return"
  if (key === "Escape") return "esc"
  if (key === "Tab") return "tab"
  if (key === "Backspace") return "backspace"
  if (key === "Delete") return "delete"
  if (key === " ") return "space"
  if (key === "ArrowLeft") return "left"
  if (key === "ArrowRight") return "right"
  if (key === "ArrowUp") return "up"
  if (key === "ArrowDown") return "down"
  if (key.length === 1) return key.toLowerCase()
  return key.toLowerCase()
}

/** Physical key from KeyboardEvent.code (Option on macOS alters event.key, not the code). */
export function domKeyNameFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]!.toLowerCase()
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]!
  const numpad = /^Numpad([0-9])$/.exec(code)
  if (numpad) return numpad[1]!
  switch (code) {
    case "Backspace":
      return "backspace"
    case "Delete":
      return "delete"
    case "Enter":
    case "NumpadEnter":
      return "return"
    case "Escape":
      return "esc"
    case "Tab":
      return "tab"
    case "Space":
      return "space"
    case "ArrowLeft":
      return "left"
    case "ArrowRight":
      return "right"
    case "ArrowUp":
      return "up"
    case "ArrowDown":
      return "down"
    case "Minus":
      return "-"
    case "Equal":
      return "="
    case "BracketLeft":
      return "["
    case "BracketRight":
      return "]"
    case "Backslash":
      return "\\"
    case "Semicolon":
      return ";"
    case "Quote":
      return "'"
    case "Comma":
      return ","
    case "Period":
      return "."
    case "Slash":
      return "/"
    case "Backquote":
      return "`"
    default:
      return null
  }
}

function useMacOptionPhysicalKey(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "code">,
  platform: DomKeyPlatform,
): boolean {
  return platform === "mac" && event.altKey && !event.ctrlKey && !event.metaKey && Boolean(event.code)
}

export function domKeyModifiers(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  platform: DomKeyPlatform,
): Pick<KeyEventLike, "ctrl" | "meta" | "super" | "shift"> {
  const ctrl = event.ctrlKey || undefined
  const shift = event.shiftKey || undefined
  if (platform === "mac") {
    return {
      ctrl,
      shift,
      meta: event.altKey || undefined,
      super: event.metaKey || undefined,
    }
  }
  return {
    ctrl,
    shift,
    meta: event.altKey || undefined,
    super: event.metaKey || undefined,
  }
}

export function domKeyFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  platform: DomKeyPlatform = domKeyPlatform(typeof navigator === "undefined" ? "" : navigator.userAgent),
): KeyEventLike {
  const physical =
    useMacOptionPhysicalKey(event, platform) && event.code
      ? domKeyNameFromCode(event.code)
      : null
  const name = physical ?? domKeyName(event.key)
  return {
    name,
    sequence: event.key,
    raw: event.key,
    ...domKeyModifiers(event, platform),
  }
}
