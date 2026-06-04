import { expect, test } from "bun:test"
import { BufferModel } from "../src/kernel/buffer"
import { findBackward, findForward, isearchMatchSpan } from "../src/kernel/isearch"

test("isearchMatchSpan covers the full query at point", () => {
  const buffer = new BufferModel({ name: "x", text: "foo bar foo" })
  buffer.point = 8
  const span = isearchMatchSpan(buffer, { bufferId: buffer.id, string: "foo", direction: 1, startPoint: 0 })
  expect(span).toEqual({ start: 8, end: 11, face: "isearch" })
})

test("findForward and findBackward locate substrings", () => {
  const text = "foo bar foo"
  expect(findForward(text, "foo", 0)).toBe(0)
  expect(findForward(text, "foo", 1)).toBe(8)
  expect(findForward(text, "baz", 0)).toBeNull()
  expect(findBackward(text, "foo", 8)).toBe(0)
  expect(findBackward(text, "foo", text.length)).toBe(8)
})
