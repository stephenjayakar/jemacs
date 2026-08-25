import type { KeyEvent } from "@opentui/core"
import { canonicalizeKeyEvent, type KeyEventLike } from "../kernel/keymap"
import { defcustom, getCustom } from "../runtime/custom"

export type MacOptionCharacterMapping = {
  key: string
  shift?: boolean
}

defcustom(
  "jemacs-translate-option-characters",
  "boolean",
  true,
  "When non-nil, translate macOS US Option-composed terminal characters to Meta key events.",
)

const MAC_US_OPTION_CHARACTERS: Array<[string, string]> = [
  ["¡", "1"], ["™", "2"], ["£", "3"], ["¢", "4"], ["∞", "5"],
  ["§", "6"], ["¶", "7"], ["•", "8"], ["ª", "9"], ["º", "0"],
  ["–", "-"], ["≠", "="],
  ["œ", "q"], ["∑", "w"], ["®", "r"], ["†", "t"], ["¥", "y"],
  ["ø", "o"], ["π", "p"], ["“", "["], ["‘", "]"], ["«", "\\"],
  ["å", "a"], ["ß", "s"], ["∂", "d"], ["ƒ", "f"], ["©", "g"],
  ["˙", "h"], ["∆", "j"], ["˚", "k"], ["¬", "l"], ["…", ";"],
  ["æ", "'"],
  ["Ω", "z"], ["≈", "x"], ["ç", "c"], ["√", "v"], ["∫", "b"],
  ["µ", "m"], ["≤", ","], ["≥", "."], ["÷", "/"],
]

const MAC_US_OPTION_SHIFT_CHARACTERS: Array<[string, string]> = [
  ["⁄", "1"], ["€", "2"], ["‹", "3"], ["›", "4"], ["ﬁ", "5"],
  ["ﬂ", "6"], ["‡", "7"], ["°", "8"], ["·", "9"], ["‚", "0"],
  ["—", "-"], ["±", "="],
  ["Œ", "q"], ["„", "w"], ["‰", "r"], ["ˇ", "t"], ["Á", "y"],
  ["Ø", "o"], ["∏", "p"], ["”", "["], ["’", "]"], ["»", "\\"],
  ["Å", "a"], ["Í", "s"], ["Î", "d"], ["Ï", "f"], ["˝", "g"],
  ["Ó", "h"], ["Ô", "j"], ["", "k"], ["Ò", "l"], ["Ú", ";"],
  ["Æ", "'"],
  ["¸", "z"], ["˛", "x"], ["Ç", "c"], ["◊", "v"], ["ı", "b"],
  ["Â", "m"], ["¯", ","], ["˘", "."], ["¿", "/"],
]

export const MAC_US_OPTION_CHARACTER_MAP: ReadonlyMap<string, MacOptionCharacterMapping> = new Map([
  ...MAC_US_OPTION_CHARACTERS.map(([char, key]) => [char, { key }] as const),
  ...MAC_US_OPTION_SHIFT_CHARACTERS.map(([char, key]) => [char, { key, shift: true }] as const),
])

const MAC_US_SHIFTED_PRINTABLE_KEYS: ReadonlyMap<string, string> = new Map([
  ["1", "!"], ["2", "@"], ["3", "#"], ["4", "$"], ["5", "%"],
  ["6", "^"], ["7", "&"], ["8", "*"], ["9", "("], ["0", ")"],
  ["-", "_"], ["=", "+"], ["[", "{"], ["]", "}"], ["\\", "|"],
  [";", ":"], ["'", "\""], [",", "<"], [".", ">"], ["/", "?"],
])

// macOS dead keys produce no immediate character, so a terminal event cannot
// recover them here: Option+`, Option+e, Option+i, Option+n, Option+u.
// Users who need those as Meta chords should enable Option-as-Meta in Terminal.
function translateMacOptionCharacter(key: KeyEventLike): KeyEventLike {
  if (getCustom<boolean>("jemacs-translate-option-characters") === false) return key
  if (key.ctrl || key.meta || key.super) return key
  if (key.sequence == null || key.sequence.length !== 1) return key
  const mapping = MAC_US_OPTION_CHARACTER_MAP.get(key.sequence)
  if (!mapping) return key
  const shiftedKey = mapping.shift ? MAC_US_SHIFTED_PRINTABLE_KEYS.get(mapping.key) : undefined
  const translatedKey = shiftedKey ?? mapping.key
  return {
    ...key,
    name: translatedKey,
    sequence: translatedKey,
    meta: true,
    shift: (mapping.shift && !shiftedKey) || undefined,
  }
}

// Enhanced terminal protocols can report the physical base key plus Shift
// instead of the resulting printable character. For example, modifyOtherKeys
// encodes M-< as comma+Meta+Shift; restore "<" so it cannot collapse to M-,.
function translateShiftedPrintableCharacter(key: KeyEventLike): KeyEventLike {
  if (!key.shift || key.name.length !== 1) return key
  const shiftedKey = MAC_US_SHIFTED_PRINTABLE_KEYS.get(key.name)
  if (!shiftedKey) return key
  return {
    ...key,
    name: shiftedKey,
    sequence: key.sequence === key.name ? shiftedKey : key.sequence,
  }
}

/** Convert an OpenTUI key event into the kernel key representation. */
export function keyEventFromOpentui(key: KeyEvent): KeyEventLike {
  const event = translateMacOptionCharacter({
    name: key.name,
    sequence: key.sequence,
    raw: key.raw,
    ctrl: key.ctrl,
    meta: key.meta || key.option,
    shift: key.shift,
    super: key.super,
  })
  return canonicalizeKeyEvent(translateShiftedPrintableCharacter(event))
}
