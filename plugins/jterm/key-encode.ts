import { normalizeSequence, type KeyEventLike } from "../../src/kernel/keymap"

export type KeyEncodeOptions = {
  /** Wrap pty input in bracketed-paste markers (\x1b[200~…\x1b[201~). The
   *  process has to opt in via the same protocol or the bytes look like garbage. */
  bracketedPaste?: boolean
}

/** Convert a KeyEventLike into the byte stream a real terminal would send to a
 *  foreground process. Mirrors term-v2/keyToPtyBytes plus the named keys that
 *  terminal modes commonly ship (Home/End/PageUp/PageDown/Insert/F1-F12). */
export function keyToPtyBytes(k: KeyEventLike, opts: KeyEncodeOptions = {}): string {
  // Meta prefixes everything with ESC. When the key is a single letter, use
  // the name (not the multi-byte sequence the host may have handed us) so the
  // child sees ESC <letter> instead of ESC <utf-8> (e.g. M-v → ESC v, not
  // ESC √).
  if (k.meta) {
    const inner: KeyEventLike = {
      ...k,
      meta: false,
      sequence: k.name.length === 1 ? k.name : k.sequence,
    }
    return "\x1b" + keyToPtyBytes(inner, opts)
  }
  let out = ""
  if (k.ctrl) {
    const name = k.name.length === 1 ? k.name : k.sequence
    if (name && name.length === 1) {
      if (name === " ") {
        out += "\x00"
      } else if (name === "?") {
        out += "\x7f"
      } else {
        const c = name.toUpperCase().charCodeAt(0)
        if (c >= 0x40 && c <= 0x5f) {
          out += String.fromCharCode(c & 0x1f)
        } else if (k.sequence) {
          out += k.sequence
        } else {
          out += name
        }
      }
    } else if (k.sequence) {
      out += k.sequence
    } else {
      out += k.name
    }
  } else {
    switch (k.name) {
      case "space": out += " "; break
      case "return":
      case "enter": out += "\r"; break
      case "tab": out += "\t"; break
      case "backspace": out += "\x7f"; break
      case "delete": out += "\x1b[3~"; break
      case "up": out += "\x1b[A"; break
      case "down": out += "\x1b[B"; break
      case "right": out += "\x1b[C"; break
      case "left": out += "\x1b[D"; break
      case "home": out += "\x1b[H"; break
      case "end": out += "\x1b[F"; break
      case "pageup": out += "\x1b[5~"; break
      case "pagedown": out += "\x1b[6~"; break
      case "insert": out += "\x1b[2~"; break
      default:
        if (k.sequence) out += k.sequence
        else if (k.raw) out += k.raw
        else out += k.name
    }
  }
  if (opts.bracketedPaste && (k as { bracketed?: boolean }).bracketed) {
    out = `\x1b[200~${out}\x1b[201~`
  }
  return out
}

/** Test helper: build a normalized sequence token from the keymap module so
 *  raw key strings can be checked against a sequence-to-bytes table. */
export function tokenFor(k: KeyEventLike): string {
  return normalizeSequence(k.name)
}
