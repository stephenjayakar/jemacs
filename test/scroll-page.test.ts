import { expect, test } from "bun:test"
import { buildDisplayModel } from "../src/display/build-display-model"
import { pageScrollLines } from "../src/display/viewport"
import { findWindowLeaf } from "../src/kernel/window"
import { themedTextPlain } from "../src/display/themed-text"
import { setCustom } from "../src/runtime/custom"
import { makeEditor } from "./plugins/helper"

// Tall enough that line 40 is visible from startLine 0 in the numeric-prefix
// test (bodyBudget = rows - 4). Pinned to lastViewport so scroll math is
// independent of process.stdout.rows.
const rows = 50
const scrollEditor = () => {
  const editor = makeEditor()
  editor.lastViewport = { rows }
  return editor
}

test("C-v / M-v use next-screen-context-lines overlap like Emacs", async () => {
  const editor = scrollEditor()
  const page = pageScrollLines(rows)
  const context = 2
  const step = page - context
  const lines = Array.from({ length: page + 10 }, (_, i) => `line ${i + 1}`).join("\n")
  editor.scratch("t.txt", lines, "text").point = 0

  await editor.run("scroll-up-command")
  expect(editor.currentBuffer.lineCol().line).toBe(step + 1)

  await editor.run("scroll-down-command")
  expect(editor.currentBuffer.lineCol().line).toBe(step + 1)
  expect(findWindowLeaf(editor.windowLayout, editor.selectedWindowId)!.startLine).toBe(0)
})

test("M-v at buffer top signals Beginning of buffer by default", async () => {
  const editor = scrollEditor()
  editor.scratch("t.txt", "line 1\nline 2\n", "text").point = 0
  expect(findWindowLeaf(editor.windowLayout, editor.selectedWindowId)!.startLine).toBe(0)

  await editor.run("scroll-down-command")
  // Emacs default: error message, point unchanged.
  expect(editor.currentBuffer.lineCol().line).toBe(1)
})

test("scroll-error-top-bottom moves to line 1 when M-v cannot scroll further", async () => {
  const editor = scrollEditor()
  const page = pageScrollLines(rows)
  const lines = Array.from({ length: page + 5 }, (_, i) => `line ${i + 1}`).join("\n")
  editor.scratch("t.txt", lines, "text").point = editor.currentBuffer.text.indexOf("line 10")

  setCustom("scroll-error-top-bottom", true)
  await editor.run("scroll-down-command")
  expect(editor.currentBuffer.lineCol().line).toBe(1)
  setCustom("scroll-error-top-bottom", false)
})

test("numeric prefix scrolls lines without moving point when it stays visible", async () => {
  const editor = scrollEditor()
  const page = pageScrollLines(rows)
  const halfWindow = Math.floor(page / 2)
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n")
  editor.scratch("t.txt", lines, "text")
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("line 40")

  editor.prefixArg.addDigit(5)
  await editor.run("scroll-up-command")
  expect(editor.currentBuffer.lineCol().line).toBe(40)
  expect(findWindowLeaf(editor.windowLayout, editor.selectedWindowId)!.startLine).toBe(39 - halfWindow + 5)
})

test("full-screen scroll moves point to top line when it scrolled off (Emacs C-v)", async () => {
  const editor = scrollEditor()
  const page = pageScrollLines(rows)
  const lines = Array.from({ length: page + 10 }, (_, i) => `line ${i + 1}`).join("\n")
  editor.scratch("t.txt", lines, "text").point = 0

  await editor.run("scroll-up-command")
  const leaf = findWindowLeaf(editor.windowLayout, editor.selectedWindowId)!
  expect(editor.currentBuffer.lineCol().line).toBe(leaf.startLine + 1)
})

test("C-v scrolls from the Emacs half-window point anchor", async () => {
  const editor = scrollEditor()
  const page = pageScrollLines(rows)
  const step = page - 2
  const halfWindow = Math.floor(page / 2)
  const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n")
  editor.scratch("t.txt", lines, "text")
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("line 40")

  await editor.run("scroll-up-command")

  const expectedStartLine = 39 - halfWindow + step
  expect(findWindowLeaf(editor.windowLayout, editor.selectedWindowId)!.startLine).toBe(expectedStartLine)
  expect(editor.currentBuffer.lineCol().line).toBe(expectedStartLine + 1)
})

test("M-v scrolls from the Emacs half-window point anchor", async () => {
  const editor = scrollEditor()
  const page = pageScrollLines(rows)
  const step = page - 2
  const halfWindow = Math.floor(page / 2)
  const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n")
  editor.scratch("t.txt", lines, "text")
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("line 70")
  editor.setSelectedWindowStartLine(40)

  await editor.run("scroll-down-command")

  const expectedStartLine = 69 - halfWindow - step
  expect(findWindowLeaf(editor.windowLayout, editor.selectedWindowId)!.startLine).toBe(expectedStartLine)
  expect(editor.currentBuffer.lineCol().line).toBe(expectedStartLine + page)
})

test("startLine 0 shows line 1 even when an early line wraps", async () => {
  const editor = scrollEditor()
  const lines = ["line 1", "X".repeat(240), ...Array.from({ length: 40 }, (_, i) => `body ${i}`)]
  editor.scratch("t.txt", lines.join("\n") + "\n", "text").point = 0

  setCustom("scroll-error-top-bottom", true)
  for (let i = 0; i < 30; i++) await editor.run("scroll-up-command")
  for (let i = 0; i < 40; i++) await editor.run("scroll-down-command")

  expect(findWindowLeaf(editor.windowLayout, editor.selectedWindowId)!.startLine).toBe(0)
  setCustom("scroll-error-top-bottom", false)

  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows, cols: 80 } })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  const firstRow = themedTextPlain(pane!.body).split("\n")[0]!
  expect(firstRow.includes("line 1")).toBe(true)
})
