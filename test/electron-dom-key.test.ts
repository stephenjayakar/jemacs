import { describe, expect, test } from "bun:test"
import { domKeyFromKeyboardEvent, domKeyModifiers, domKeyName, domKeyTerminalBytes, isDomHideShortcut, isDomModifierOnlyKey, isDomPasteShortcut } from "../src/electron/dom-key"
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
  expect(keyToken(domKeyFromKeyboardEvent({ key: "v", code: "KeyV", ctrlKey: false, metaKey: false, altKey: true, shiftKey: false }, "mac"))).toBe("M-v")
  expect(keyToken(domKeyFromKeyboardEvent({ key: "v", code: "KeyV", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }, "mac"))).toBe("s-v")
})

test("mac Command+V is reserved for host clipboard paste", () => {
  const event = { key: "v", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }
  expect(isDomPasteShortcut(event, "mac")).toBe(true)
  expect(isDomPasteShortcut({ ...event, altKey: true }, "mac")).toBe(false)
  expect(isDomPasteShortcut({ ...event, shiftKey: true }, "mac")).toBe(false)
  expect(isDomPasteShortcut(event, "other")).toBe(false)
})

test("mac Command+H is reserved for hiding the Electron application", () => {
  const event = { key: "h", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }
  expect(isDomHideShortcut(event, "mac")).toBe(true)
  expect(isDomHideShortcut({ ...event, shiftKey: true }, "mac")).toBe(false)
  expect(isDomHideShortcut(event, "other")).toBe(false)
})

test("non-mac Alt+v is Meta, Win/Meta+v is Super", () => {
  expect(
    keyToken(domKeyFromKeyboardEvent({ key: "v", code: "KeyV", ctrlKey: false, metaKey: false, altKey: true, shiftKey: false }, "other")),
  ).toBe("M-v")
  expect(
    keyToken(domKeyFromKeyboardEvent({ key: "v", code: "KeyV", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }, "other")),
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

test("raw composed glyphs stay literal in the kernel; hosts translate them", () => {
  // The old kernel-level mac-Option shim is gone: the DOM host uses the
  // physical key code and the terminal host uses the Option table in
  // src/ui/opentui-key.ts, so a bare glyph reaching keyToken is just itself.
  expect(keyToken({ name: "√", sequence: "√" })).toBe("√")
})

test("GUI special keys carry terminal bytes, not DOM key names", () => {
  const enter = domKeyFromKeyboardEvent({ key: "Enter", code: "Enter", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, "mac")
  expect(enter.name).toBe("return")
  expect(enter.sequence).toBe("\r")
  expect(enter.raw).toBe("\r")

  const backspace = domKeyFromKeyboardEvent({ key: "Backspace", code: "Backspace", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, "mac")
  expect(backspace.name).toBe("backspace")
  expect(backspace.sequence).toBe("\x7f")
  expect(backspace.raw).toBe("\x7f")

  expect(domKeyTerminalBytes({ key: "ArrowUp", code: "ArrowUp", shiftKey: false })).toBe("\x1b[A")
})

test("GUI renderer can ignore modifier-only keydown events", () => {
  expect(isDomModifierOnlyKey("Shift")).toBe(true)
  expect(isDomModifierOnlyKey("Meta")).toBe(true)
  expect(isDomModifierOnlyKey("a")).toBe(false)
})
