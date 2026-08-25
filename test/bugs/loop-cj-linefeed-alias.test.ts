import { expect, test } from "bun:test"
import { Keymap, KeymapStack, normalizeToken } from "../../src/kernel/keymap"

test("C-j and linefeed canonicalize to the same token", () => {
  expect(normalizeToken("linefeed")).toBe(normalizeToken("C-j"))
  expect(normalizeToken("LFD")).toBe(normalizeToken("C-j"))
})

test("C-m/return and C-i alias to enter/tab", () => {
  expect(normalizeToken("C-m")).toBe(normalizeToken("enter"))
  expect(normalizeToken("return")).toBe(normalizeToken("enter"))
  expect(normalizeToken("RET")).toBe(normalizeToken("enter"))
  expect(normalizeToken("C-i")).toBe(normalizeToken("tab"))
  expect(normalizeToken("TAB")).toBe(normalizeToken("tab"))
  expect(normalizeToken("DEL")).toBe(normalizeToken("backspace"))
  expect(normalizeToken("SPC")).toBe(normalizeToken("space"))
})

test("binding 'C-j' matches OpenTUI {name:'linefeed'} via KeymapStack", () => {
  const km = new Keymap("test")
  km.bind("C-j", "newline-and-indent")
  const stack = new KeymapStack(() => [{ name: "test", keymap: km }])
  const fed = stack.feed({ name: "linefeed" })
  expect(fed.status).toBe("matched")
  if (fed.status === "matched") expect(fed.command).toBe("newline-and-indent")
})

test("binding 'linefeed' matches a 'C-j' lookup (bidirectional)", () => {
  const km = new Keymap("test")
  km.bind("linefeed", "lfd-cmd")
  expect(km.get("C-j")).toBe("lfd-cmd")
})

test("normalizeToken normalizes uppercase key names to include shift prefix", () => {
  expect(normalizeToken("F")).toBe("S-f")
  expect(normalizeToken("A")).toBe("S-a")
  expect(normalizeToken("S-f")).toBe("S-f")
  expect(normalizeToken("S-F")).toBe("S-f")
})
