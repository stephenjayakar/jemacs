import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { TERMINAL_SURFACE_LOCAL } from "../../src/display/terminal-surface"
import { getMode } from "../../src/modes/mode"
import { install, feed, makeXTerm, sessions, termRawMap, type TermSession } from "../../plugins/vterm"
import type { Pty } from "../../plugins/term/pty"
import { makeEditor } from "./helper"

function fakePty(): Pty & { sent: string; resizes: Array<[number, number]> } {
  let sent = ""
  const resizes: Array<[number, number]> = []
  return {
    pid: 0,
    get sent() { return sent },
    resizes,
    write(data) { sent += data },
    resize(rows, cols) { resizes.push([rows, cols]) },
    onData() {},
    onExit() {},
    kill() {},
  }
}

function feedAsync(session: TermSession, buffer: BufferModel, chunk: string): Promise<void> {
  return new Promise(resolve => feed(session, buffer, chunk, resolve))
}

test("vterm registers Emacs-style commands and keeps copy-mode keys editable", () => {
  const editor = makeEditor()
  install(editor)

  expect(editor.commands.get("vterm")).toBeDefined()
  expect(editor.commands.get("vterm-copy-mode")).toBeDefined()
  expect(editor.commands.get("vterm-char-mode")).toBeDefined()
  expect(editor.commands.get("vterm-send-raw")).toBeDefined()
  expect(editor.commands.get("opencode")).toBeDefined()
  expect(getMode("vterm")?.keymap?.get("a")).toBeUndefined()
  expect(getMode("term")?.keymap?.get("a")).toBe("term-send-raw")
})

test("vterm char-mode renders a terminal surface; copy-mode falls back to buffer text", async () => {
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("*vterm*", "", "vterm")
  const pty = fakePty()
  const session: TermSession = { pty, xt: makeXTerm(4, 12), rows: 4, cols: 12 }
  sessions.set(buffer, session)

  await editor.run("vterm-char-mode")
  expect(buffer.readOnly).toBe(true)
  expect(editor.overridingTerminalLocalMap).toBe(termRawMap)

  await feedAsync(session, buffer, "\x1b[31mred\x1b[0m\r\nplain")
  const surface = buffer.locals.get(TERMINAL_SURFACE_LOCAL)
  expect(surface).toMatchObject({ kind: "terminal", rows: 4, cols: 12 })

  await editor.run("vterm-copy-mode")
  expect(buffer.readOnly).toBe(false)
  expect(editor.overridingTerminalLocalMap).toBeNull()
  expect(buffer.locals.get(TERMINAL_SURFACE_LOCAL)).toBeUndefined()
  expect(buffer.text).toContain("red")
  expect(buffer.text).toContain("plain")
})
