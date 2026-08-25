import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { getMode, modeFeature, type TextSpan } from "../../src/modes/mode"
import { changeLogFontLock, installLogModes, logEditFontLock, logViewFontLock } from "../../src/modes/log"

function expectSpan(text: string, spans: TextSpan[], needle: string, face: TextSpan["face"]): void {
  const start = text.indexOf(needle)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

function expectSpanAt(text: string, spans: TextSpan[], needle: string, start: number, face: TextSpan["face"]): void {
  expect(start).toBeGreaterThanOrEqual(0)
  expect(text.slice(start, start + needle.length)).toBe(needle)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

test("log modes register GNU mode names", () => {
  installLogModes()

  expect(getMode("log-edit-mode")?.parent).toBe("text")
  expect(getMode("log-edit-mode")?.commentStart).toBe("#")
  expect(modeFeature("log-edit-mode", "fontLock")).toBe(logEditFontLock)
  expect(getMode("log-view-mode")?.parent).toBe("text")
  expect(modeFeature("log-view-mode", "fontLock")).toBe(logViewFontLock)
  expect(getMode("change-log-mode")?.parent).toBe("text")
  expect(modeFeature("change-log-mode", "fontLock")).toBe(changeLogFontLock)
})

test("log-edit-mode font-lock highlights headers, long summary text, and comments", () => {
  installLogModes()
  const longSummary = "x".repeat(55)
  const text = [
    "Summary: Update parser",
    "Reviewer: Stephen",
    "",
    longSummary,
    "# Please enter the commit message",
  ].join("\n")
  const buffer = new BufferModel({ name: "COMMIT_EDITMSG", text, mode: "log-edit-mode" })
  const spans = logEditFontLock(buffer)
  const warningStart = text.indexOf(longSummary) + 50

  expectSpan(text, spans, "Summary:", "keyword")
  expectSpan(text, spans, "Reviewer:", "keyword")
  expectSpanAt(text, spans, "x".repeat(5), warningStart, "warning")
  expectSpan(text, spans, "# Please enter the commit message", "comment")

  const ranged = logEditFontLock(buffer, { startLine: 3, endLine: 5, start: buffer.lineStarts[3]!, end: text.length })
  expect(ranged.some(span => text.slice(span.start, span.end) === "Summary:")).toBe(false)
  expectSpanAt(text, ranged, "x".repeat(5), warningStart, "warning")
  expectSpan(text, ranged, "# Please enter the commit message", "comment")
})

test("log-view-mode font-lock highlights commit metadata and one-line shas", () => {
  installLogModes()
  const text = [
    "commit 1234567890abcdef1234567890abcdef12345678",
    "Author: Stephen <stephen@example.test>",
    "Date:   Mon Jul 6 12:34:56 2026 -0700",
    "",
    "abc1234 Add log modes",
  ].join("\n")
  const buffer = new BufferModel({ name: "*vc-log*", text, mode: "log-view-mode" })
  const spans = logViewFontLock(buffer)

  expectSpan(text, spans, "commit", "keyword")
  expectSpan(text, spans, "1234567890abcdef1234567890abcdef12345678", "constant")
  expectSpan(text, spans, "Author:", "keyword")
  expectSpan(text, spans, "Date:", "keyword")
  expectSpan(text, spans, "abc1234", "constant")
})

test("change-log-mode font-lock highlights headings, file entries, and functions", () => {
  installLogModes()
  const text = [
    "2026-07-06  Stephen  <stephen@example.test>",
    "",
    "\t* src/modes/log.ts (logEditFontLock): Add log edit highlighting.",
    "\t(changeLogFontLock): Add ChangeLog highlighting.",
  ].join("\n")
  const buffer = new BufferModel({ name: "ChangeLog", text, mode: "change-log-mode" })
  const spans = changeLogFontLock(buffer)

  expectSpan(text, spans, "2026-07-06  Stephen  <stephen@example.test>", "type")
  expectSpan(text, spans, "src/modes/log.ts", "constant")
  expectSpan(text, spans, "logEditFontLock", "function")
  expectSpan(text, spans, "changeLogFontLock", "function")
})
