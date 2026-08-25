import { expect, test } from "bun:test"
import { regionSpanWithCursor, textWithCursor } from "../src/ui/text-display"

test("textWithCursor inserts cursor at point", () => {
  expect(textWithCursor("hello", 0)).toBe("█ello")
  expect(textWithCursor("hello", 2)).toBe("he█lo")
  expect(textWithCursor("hello", 5)).toBe("hello█")
})

test("regionSpanWithCursor spans point..mark in either direction", () => {
  expect(regionSpanWithCursor("hello", 1, 4)).toEqual({ start: 1, end: 4 })
  expect(regionSpanWithCursor("hello", 4, 1)).toEqual({ start: 1, end: 4 })
})

test("regionSpanWithCursor reports nothing without a region", () => {
  expect(regionSpanWithCursor("hello", 2, null)).toBeNull()
  expect(regionSpanWithCursor("hello", 2, undefined)).toBeNull()
  // An empty region is not painted, matching Emacs.
  expect(regionSpanWithCursor("hello", 2, 2)).toBeNull()
})

test("regionSpanWithCursor shifts past a cursor glyph that added a character", () => {
  // Point at end of text: textWithCursor appends "█", so offsets after point move by one.
  expect(textWithCursor("hello", 5)).toBe("hello█")
  expect(regionSpanWithCursor("hello", 5, 2)).toEqual({ start: 2, end: 5 })

  // Point mid-text overwrites the character under it, so nothing shifts.
  expect(textWithCursor("hello", 2)).toBe("he█lo")
  expect(regionSpanWithCursor("hello", 2, 5)).toEqual({ start: 2, end: 5 })

  // "insert" hosts never overwrite, so a mark after point always shifts.
  expect(regionSpanWithCursor("hello", 2, 5, "insert")).toEqual({ start: 2, end: 6 })
})

test("regionSpanWithCursor clamps out-of-range point and mark", () => {
  expect(regionSpanWithCursor("hello", -3, 99)).toEqual({ start: 0, end: 5 })
})
