import { expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { keyToken } from "../src/kernel/keymap"
import { getCustom, setCustom } from "../src/runtime/custom"
import { keyEventFromOpentui, MAC_US_OPTION_CHARACTER_MAP } from "../src/ui/opentui-key"

function opentuiKey(sequence: string, overrides: Partial<KeyEvent> = {}): KeyEvent {
  return {
    name: sequence,
    sequence,
    raw: sequence,
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    super: false,
    ...overrides,
  } as KeyEvent
}

test("OpenTUI translates macOS Option letters to Meta keys", () => {
  expect(keyToken(keyEventFromOpentui(opentuiKey("¥")))).toBe("M-y")
  expect(keyToken(keyEventFromOpentui(opentuiKey("ƒ")))).toBe("M-f")
  expect(keyEventFromOpentui(opentuiKey("å"))).toMatchObject({ name: "a", sequence: "a", meta: true })
})

test("OpenTUI translates macOS Option digits and punctuation to Meta keys", () => {
  expect(keyToken(keyEventFromOpentui(opentuiKey("™")))).toBe("M-2")
  expect(keyToken(keyEventFromOpentui(opentuiKey("≥")))).toBe("M-.")
  expect(keyToken(keyEventFromOpentui(opentuiKey("≤")))).toBe("M-,")
  expect(keyToken(keyEventFromOpentui(opentuiKey("÷")))).toBe("M-/")
})

test("OpenTUI marks macOS Option-Shift compositions with shift", () => {
  expect(keyToken(keyEventFromOpentui(opentuiKey("Œ")))).toBe("M-S-q")
  expect(keyToken(keyEventFromOpentui(opentuiKey("ﬁ")))).toBe("M-%")
  expect(keyToken(keyEventFromOpentui(opentuiKey("¯")))).toBe("M-<")
  expect(keyToken(keyEventFromOpentui(opentuiKey("˘")))).toBe("M->")
  expect(keyToken(keyEventFromOpentui(opentuiKey("¿")))).toBe("M-?")
})

test("OpenTUI leaves modified and multi-character sequences untouched", () => {
  expect(keyEventFromOpentui(opentuiKey("¥", { ctrl: true }))).toMatchObject({ name: "¥", sequence: "¥", ctrl: true })
  expect(keyEventFromOpentui(opentuiKey("¥", { meta: true }))).toMatchObject({ name: "¥", sequence: "¥", meta: true })
  expect(keyEventFromOpentui(opentuiKey("¥", { option: true }))).toMatchObject({ name: "¥", sequence: "¥", meta: true })
  expect(keyEventFromOpentui(opentuiKey("¥x"))).toMatchObject({ name: "¥x", sequence: "¥x" })
})

test("jemacs-translate-option-characters disables OpenTUI Option glyph translation", () => {
  const before = getCustom<boolean>("jemacs-translate-option-characters")
  setCustom("jemacs-translate-option-characters", false)
  try {
    expect(keyEventFromOpentui(opentuiKey("¥"))).toMatchObject({ name: "¥", sequence: "¥" })
    expect(keyToken(keyEventFromOpentui(opentuiKey("¥")))).toBe("¥")
  } finally {
    setCustom("jemacs-translate-option-characters", before ?? true)
  }
})

test("macOS US Option composition table covers representative layout groups", () => {
  expect(MAC_US_OPTION_CHARACTER_MAP.get("¥")).toEqual({ key: "y" })
  expect(MAC_US_OPTION_CHARACTER_MAP.get("™")).toEqual({ key: "2" })
  expect(MAC_US_OPTION_CHARACTER_MAP.get("≥")).toEqual({ key: "." })
  expect(MAC_US_OPTION_CHARACTER_MAP.get("Œ")).toEqual({ key: "q", shift: true })
  expect(MAC_US_OPTION_CHARACTER_MAP.get("˘")).toEqual({ key: ".", shift: true })
})
