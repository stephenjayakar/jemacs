import { describe, expect, test } from "bun:test"
import { domKeyFromKeyboardEvent, domKeyModifiers, domKeyName } from "../src/electron/dom-key"
import { keyToken } from "../src/kernel/keymap"

test("domKeyName maps DOM special keys to Emacs-style names", () => {
  expect(domKeyName("ArrowLeft")).toBe("left")
  expect(domKeyName("Escape")).toBe("esc")
  expect(domKeyName("Enter")).toBe("return")
})

test("mac Option+v is Meta, Command+v is Super", () => {
  const mods = (init: Partial<KeyboardEvent>) =>
    domKeyModifiers(
      { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init },
      "mac",
    )
  expect(mods({ altKey: true })).toEqual({ meta: true })
  expect(mods({ metaKey: true })).toEqual({ super: true })
  expect(keyToken(domKeyFromKeyboardEvent({ key: "v", ctrlKey: false, metaKey: false, altKey: true, shiftKey: false }, "mac"))).toBe("M-v")
  expect(keyToken(domKeyFromKeyboardEvent({ key: "v", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }, "mac"))).toBe("s-v")
})

test("non-mac Alt+v is Meta, Win/Meta+v is Super", () => {
  expect(
    keyToken(domKeyFromKeyboardEvent({ key: "v", ctrlKey: false, metaKey: false, altKey: true, shiftKey: false }, "other")),
  ).toBe("M-v")
  expect(
    keyToken(domKeyFromKeyboardEvent({ key: "v", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }, "other")),
  ).toBe("s-v")
})

test("M-backspace uses Meta modifier on mac Option+Backspace", () => {
  const key = domKeyFromKeyboardEvent(
    { key: "Backspace", ctrlKey: false, metaKey: false, altKey: true, shiftKey: false, code: "Backspace" },
    "mac",
  )
  expect(keyToken(key)).toBe("M-backspace")
})

test("mac Option+v uses physical KeyV despite √ in event.key", () => {
  const key = domKeyFromKeyboardEvent(
    { key: "√", code: "KeyV", ctrlKey: false, metaKey: false, altKey: true, shiftKey: false },
    "mac",
  )
  expect(key.name).toBe("v")
  expect(key.sequence).toBe("√")
  expect(keyToken(key)).toBe("M-v")
})

test("macOptionMeta maps √ for terminal-style payloads", () => {
  expect(keyToken({ name: "√", sequence: "√" })).toBe("M-v")
})
