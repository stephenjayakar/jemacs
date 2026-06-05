import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { install, sessions, termRawMap } from "../../plugins/term"
import type { Pty } from "../../plugins/term/pty"

function fakePty(): Pty {
  return { pid: 0, write() {}, resize() {}, onData() {}, onExit() {}, kill() {} }
}

// t-f2e861cb: overridingTerminalLocalMap is editor-global. Mouse-click into
// another window while char-mode is on, shell exits → onExit only ran
// term-line-mode when currentBuffer===term, so the override stayed. Every key
// then resolved to term-send-raw → "No term session"; editor soft-locked.
test("term: override cleared when pty exits with currentBuffer ≠ term; keyboard-quit is a universal escape", async () => {
  const editor = makeEditor()
  install(editor)
  const termBuf = editor.scratch("*term*", "")
  termBuf.mode = "term"
  sessions.set(termBuf, { pty: fakePty(), lines: [""], row: 0, col: 0 })

  await editor.run("term-char-mode")
  expect(editor.overridingTerminalLocalMap).toBe(termRawMap)

  // User clicks into *scratch*; char-mode override is still installed.
  const scratch = editor.switchToBuffer("*scratch*")
  expect(editor.currentBuffer).toBe(scratch)
  expect(scratch).not.toBe(termBuf)

  // Shell exits. The session is gone but the override remains — this is the
  // soft-lock: 'a' resolves through termRawMap to term-send-raw on *scratch*.
  sessions.delete(termBuf)
  const r = await editor.handleKey({ name: "a", sequence: "a" })
  expect(r).toEqual({ status: "command", command: "term-send-raw" })

  // Universal escape: keyboard-quit must drop the term override so the global
  // map is reachable again (M-x keyboard-quit, or C-g once that resolves).
  await editor.run("keyboard-quit")
  expect(editor.overridingTerminalLocalMap).toBeNull()

  // And term-line-mode must clear the override even with no live session on
  // the current buffer — the C-c C-j escape hatch can't depend on session state.
  editor.overridingTerminalLocalMap = termRawMap
  await editor.run("term-line-mode")
  expect(editor.overridingTerminalLocalMap).toBeNull()
})
