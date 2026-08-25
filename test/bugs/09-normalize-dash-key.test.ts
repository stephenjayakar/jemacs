import { expect, test } from "bun:test"
import { normalizeToken } from "../../src/kernel/keymap"

test("normalizeToken preserves '-' as the key after a modifier", () => {
  expect(normalizeToken("M--")).toBe("M--")
  expect(normalizeToken("C--")).toBe("C--")
  expect(normalizeToken("-p")).toBe("- p")
})
