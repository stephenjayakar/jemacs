import { expect, test } from "bun:test"
import { textWithCursor } from "../src/ui/text-display"

test("textWithCursor inserts cursor at point", () => {
  expect(textWithCursor("hello", 0)).toBe("█ello")
  expect(textWithCursor("hello", 2)).toBe("he█lo")
  expect(textWithCursor("hello", 5)).toBe("hello█")
})
