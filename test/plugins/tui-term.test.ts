import { expect, test, describe, beforeEach } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { TERMINAL_SURFACE_LOCAL } from "../../src/display/terminal-surface"
import { getMode } from "../../src/modes/mode"
import {
  install,
  makeXTerm,
  sessions,
  tuiTermRawMap,
  TuiTermSession,
  sessionFor,
  surfaceChanged,
} from "../../plugins/tui-term"
import type { Pty } from "../../plugins/term/pty"
import { makeEditor } from "./helper"
import { keyToPtyBytes } from "../../plugins/tui-term/key-encode"

function fakePty(): Pty & { sent: string; chunks: string[]; resizes: Array<[number, number]> } {
  let sent = ""
  const chunks: string[] = []
  const resizes: Array<[number, number]> = []
  const dataHandlers: Array<(c: string) => void> = []
  const exitHandlers: Array<(c: number | null) => void> = []
  return {
    pid: 0,
    get sent() { return sent },
    chunks,
    resizes,
    write(d) { sent += d; chunks.push(d) },
    resize(rows, cols) { resizes.push([rows, cols]) },
    onData(fn) { dataHandlers.push(fn) },
    onExit(fn) { exitHandlers.push(fn) },
    kill() { for (const h of exitHandlers) h(0) },
  }
}

function makeSession(rows = 4, cols = 20): { session: TuiTermSession; buffer: BufferModel; pty: ReturnType<typeof fakePty> } {
  const editor = makeEditor()
  const buffer = new BufferModel({ name: "*tui-term*", kind: "scratch" })
  const pty = fakePty()
  const xt = makeXTerm(rows, cols)
  const session = new TuiTermSession(editor, buffer, pty, xt, rows, cols, "tui-term")
  return { session, buffer, pty }
}

function feedAsync(s: TuiTermSession, _b: BufferModel, chunk: string): Promise<void> {
  return s.feed(chunk)
}

describe("tui-term: install wiring", () => {
  test("registers Emacs-style commands and the tui-term mode keymap", () => {
    const editor = makeEditor()
    install(editor)

    // Top-level entry points
    expect(editor.commands.get("tui-term")).toBeDefined()
    expect(editor.commands.get("tui-term-run-command")).toBeDefined()
    expect(editor.commands.get("opencode")).toBeDefined()

    // char-mode / copy-mode toggle
    expect(editor.commands.get("tui-term-char-mode")).toBeDefined()
    expect(editor.commands.get("tui-term-copy-mode")).toBeDefined()

    // send / interrupt / kill / clear / reset
    expect(editor.commands.get("tui-term-send-raw")).toBeDefined()
    expect(editor.commands.get("tui-term-send-string")).toBeDefined()
    expect(editor.commands.get("tui-term-interrupt")).toBeDefined()
    expect(editor.commands.get("tui-term-kill")).toBeDefined()
    expect(editor.commands.get("tui-term-clear")).toBeDefined()
    expect(editor.commands.get("tui-term-reset")).toBeDefined()
    expect(editor.commands.get("tui-term-yank")).toBeDefined()

    // Mode is registered
    const map = getMode("tui-term")?.keymap
    expect(map).toBeDefined()
    expect(map?.get("a")).toBe("tui-term-send-raw")
    expect(map?.get("C-c C-c")).toBe("tui-term-interrupt")
    expect(map?.get("C-c C-j")).toBe("tui-term-copy-mode")
    expect(map?.get("C-c C-l")).toBe("tui-term-clear")
  })

  test("does not collide with the vterm plugin's commands", () => {
    // The two plugins are independent. vterm binds term-send-raw; tui-term
    // binds tui-term-send-raw. Both should coexist.
    const editor = makeEditor()
    install(editor)
    expect(editor.commands.get("tui-term-send-raw")).toBeDefined()
    expect(editor.commands.get("tui-term-interrupt")).toBeDefined()
  })
})

describe("tui-term: char-mode / copy-mode", () => {
  test("char-mode sets read-only + raw keymap + paste-handler", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*tui-term*", "", "tui-term")
    const pty = fakePty()
    const session = new TuiTermSession(editor, buffer, pty, makeXTerm(4, 20), 4, 20, "tui-term")
    sessions.set(buffer, session)

    await editor.run("tui-term-char-mode")
    expect(buffer.readOnly).toBe(true)
    expect(editor.overridingTerminalLocalMap).toBe(tuiTermRawMap)
    expect(buffer.locals.has("paste-handler")).toBe(true)
    expect(session.charMode).toBe(true)
  })

  test("copy-mode clears read-only + raw keymap + paste-handler + surface", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*tui-term*", "", "tui-term")
    const pty = fakePty()
    const session = new TuiTermSession(editor, buffer, pty, makeXTerm(4, 20), 4, 20, "tui-term")
    sessions.set(buffer, session)

    await editor.run("tui-term-char-mode")
    expect(buffer.readOnly).toBe(true)

    await editor.run("tui-term-copy-mode")
    expect(buffer.readOnly).toBe(false)
    expect(editor.overridingTerminalLocalMap).toBeNull()
    expect(buffer.locals.has("paste-handler")).toBe(false)
    expect(buffer.locals.get(TERMINAL_SURFACE_LOCAL)).toBeUndefined()
    expect(session.charMode).toBe(false)
  })

  test("keyboard-quit tears down the char-mode override", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*tui-term*", "", "tui-term")
    sessions.set(buffer, new TuiTermSession(editor, buffer, fakePty(), makeXTerm(4, 20), 4, 20, "tui-term"))

    await editor.run("tui-term-char-mode")
    expect(editor.overridingTerminalLocalMap).toBe(tuiTermRawMap)

    await editor.run("keyboard-quit")
    expect(editor.overridingTerminalLocalMap).toBeNull()
  })

  test("char-mode without a session is a no-op (no crash)", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*unrelated*", "", "text")
    editor.switchToBuffer(buffer.id)
    await editor.run("tui-term-char-mode")
    // No session attached → command short-circuits with a message.
    expect(buffer.readOnly).toBe(false)
    expect(editor.overridingTerminalLocalMap).toBeNull()
  })
})

describe("tui-term: paste routing via buffer.locals['paste-handler']", () => {
  test("paste-handler installed by char-mode writes to the pty", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*tui-term*", "", "tui-term")
    const pty = fakePty()
    sessions.set(buffer, new TuiTermSession(editor, buffer, pty, makeXTerm(4, 20), 4, 20, "tui-term"))

    await editor.run("tui-term-char-mode")
    const handler = buffer.locals.get("paste-handler") as (text: string) => void
    handler("hello world")
    await Promise.resolve()
    // Default bracketed-paste is on, so the pty receives \x1b[200~hello world\x1b[201~
    expect(pty.chunks.length).toBe(1)
    expect(pty.chunks[0]).toBe("\x1b[200~hello world\x1b[201~")
  })

  test("paste-handler is a no-op (no insert) — the buffer is read-only", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*tui-term*", "", "tui-term")
    const pty = fakePty()
    sessions.set(buffer, new TuiTermSession(editor, buffer, pty, makeXTerm(4, 20), 4, 20, "tui-term"))

    await editor.run("tui-term-char-mode")
    const handler = buffer.locals.get("paste-handler") as (text: string) => void
    handler("ignore me")
    await Promise.resolve()
    // The buffer text was never inserted into.
    expect(buffer.text).toBe("")
  })

  test("disabling bracketed-paste sends raw bytes", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*tui-term*", "", "tui-term")
    const pty = fakePty()
    sessions.set(buffer, new TuiTermSession(editor, buffer, pty, makeXTerm(4, 20), 4, 20, "tui-term"))

    await editor.run("tui-term-char-mode")
    editor.locals.set("tui-term-bracketed-paste", false)
    const handler = buffer.locals.get("paste-handler") as (text: string) => void
    handler("ls -la")
    await Promise.resolve()
    expect(pty.chunks[0]).toBe("ls -la")
  })
})

describe("tui-term: kill-emacs-hook and kill-buffer-hook", () => {
  test("kill-emacs-hook kills all live PTY processes", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*tui-term*", "", "tui-term")
    const pty = fakePty()
    let killed = false
    pty.kill = () => { killed = true }
    sessions.set(buffer, new TuiTermSession(editor, buffer, pty, makeXTerm(4, 20), 4, 20, "tui-term"))

    // kill-emacs-hook fires from editor.quit(); runHook("kill-emacs-hook") is
    // the same path the test harness can take.
    await editor.runHook("kill-emacs-hook", editor.currentBuffer)
    expect(killed).toBe(true)
  })

  test("kill-buffer-hook disposes the session for the killed buffer", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*tui-term*", "", "tui-term")
    const pty = fakePty()
    let killed = false
    pty.kill = () => { killed = true }
    sessions.set(buffer, new TuiTermSession(editor, buffer, pty, makeXTerm(4, 20), 4, 20, "tui-term"))

    editor.killBuffer(buffer.id)
    expect(killed).toBe(true)
    expect(sessionFor(buffer)).toBeUndefined()
  })
})

describe("tui-term: keyToPtyBytes (kept from term-v2 + extended)", () => {
  test("printable chars pass through via sequence", () => {
    expect(keyToPtyBytes({ name: "a", sequence: "a" })).toBe("a")
    expect(keyToPtyBytes({ name: "/", sequence: "/" })).toBe("/")
  })
  test("named keys map to control bytes", () => {
    expect(keyToPtyBytes({ name: "return" })).toBe("\r")
    expect(keyToPtyBytes({ name: "enter" })).toBe("\r")
    expect(keyToPtyBytes({ name: "space" })).toBe(" ")
    expect(keyToPtyBytes({ name: "backspace" })).toBe("\x7f")
    expect(keyToPtyBytes({ name: "tab" })).toBe("\t")
  })
  test("control and meta keys encode like terminal input", () => {
    expect(keyToPtyBytes({ name: "c", ctrl: true, sequence: "c" })).toBe("\x03")
    expect(keyToPtyBytes({ name: "v", meta: true, sequence: "√" })).toBe("\x1bv")
  })
  test("navigation keys emit xterm sequences", () => {
    expect(keyToPtyBytes({ name: "up" })).toBe("\x1b[A")
    expect(keyToPtyBytes({ name: "down" })).toBe("\x1b[B")
    expect(keyToPtyBytes({ name: "left" })).toBe("\x1b[D")
    expect(keyToPtyBytes({ name: "right" })).toBe("\x1b[C")
    expect(keyToPtyBytes({ name: "home" })).toBe("\x1b[H")
    expect(keyToPtyBytes({ name: "end" })).toBe("\x1b[F")
    expect(keyToPtyBytes({ name: "pageup" })).toBe("\x1b[5~")
    expect(keyToPtyBytes({ name: "pagedown" })).toBe("\x1b[6~")
    expect(keyToPtyBytes({ name: "insert" })).toBe("\x1b[2~")
    expect(keyToPtyBytes({ name: "delete" })).toBe("\x1b[3~")
  })
})

describe("tui-term: surfaceChanged (cell-level diff)", () => {
  test("identical surfaces compare equal", () => {
    const s = {
      kind: "terminal" as const,
      rows: 2,
      cols: 3,
      cursorRow: 0,
      cursorCol: 0,
      cells: [[{ text: "a" }, { text: "b" }, { text: "c" }], [{ text: "d" }, { text: "e" }, { text: "f" }]],
    }
    expect(surfaceChanged(s, JSON.parse(JSON.stringify(s)))).toBe(false)
  })
  test("any text change is detected", () => {
    const a = { kind: "terminal" as const, rows: 1, cols: 1, cursorRow: 0, cursorCol: 0, cells: [[{ text: "a" }]] }
    const b = { kind: "terminal" as const, rows: 1, cols: 1, cursorRow: 0, cursorCol: 0, cells: [[{ text: "b" }]] }
    expect(surfaceChanged(a, b)).toBe(true)
  })
  test("color change is detected", () => {
    const a = { kind: "terminal" as const, rows: 1, cols: 1, cursorRow: 0, cursorCol: 0, cells: [[{ text: "x", fg: "#ff0000" }]] }
    const b = { kind: "terminal" as const, rows: 1, cols: 1, cursorRow: 0, cursorCol: 0, cells: [[{ text: "x", fg: "#00ff00" }]] }
    expect(surfaceChanged(a, b)).toBe(true)
  })
  test("cursor move is detected even when text is identical", () => {
    const a = { kind: "terminal" as const, rows: 2, cols: 2, cursorRow: 0, cursorCol: 0, cells: [[{ text: "a" }, { text: "b" }], [{ text: "c" }, { text: "d" }]] }
    const b = { kind: "terminal" as const, rows: 2, cols: 2, cursorRow: 1, cursorCol: 0, cells: [[{ text: "a" }, { text: "b" }], [{ text: "c" }, { text: "d" }]] }
    expect(surfaceChanged(a, b)).toBe(true)
  })
  test("null previous always diffs (first paint)", () => {
    const s = { kind: "terminal" as const, rows: 1, cols: 1, cursorRow: 0, cursorCol: 0, cells: [[{ text: "a" }]] }
    expect(surfaceChanged(null, s)).toBe(true)
  })
})

describe("tui-term: VT parsing via @xterm/headless", () => {
  test("plain output with CRLF renders as lines; point follows cursor", async () => {
    const { session, buffer } = makeSession()
    await feedAsync(session, buffer, "hello\r\nworld\r\n$ ")
    expect(buffer.text).toBe("hello\nworld\n$ ")
    expect(buffer.point).toBe(buffer.text.length)
  })
  test("SGR color codes are consumed, not leaked", async () => {
    const { session, buffer } = makeSession()
    await feedAsync(session, buffer, "plain \x1b[31mred\x1b[0m \x1b[1;32mbold-green\x1b[0m\r\n")
    expect(buffer.text).toBe("plain red bold-green\n")
    expect(buffer.text).not.toContain("\x1b")
  })
  test("absolute cursor positioning overwrites grid cells", async () => {
    const { session, buffer } = makeSession()
    await feedAsync(session, buffer, "AAAAA\r\nBBBBB\r\nCCCCC")
    await feedAsync(session, buffer, "\x1b[2;2HXX")
    expect(buffer.text.split("\n")[1]).toBe("BXXBB")
  })
  test("char-mode installs a surface with the correct shape", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*tui-term*", "", "tui-term")
    const session = new TuiTermSession(editor, buffer, fakePty(), makeXTerm(3, 6), 3, 6, "tui-term")
    sessions.set(buffer, session)
    await feedAsync(session, buffer, "hi\r\nthere\r\n$ ")
    await editor.run("tui-term-char-mode")
    const surface = buffer.locals.get(TERMINAL_SURFACE_LOCAL)
    expect(surface).toMatchObject({ kind: "terminal", rows: 3, cols: 6 })
  })
})

describe("tui-term: writeRaw microtask batching", () => {
  test("same-tick writes coalesce into one pty.write on the next microtask", async () => {
    const { session, pty } = makeSession()
    session.writeRaw("h")
    session.writeRaw("i")
    expect(pty.chunks).toEqual([])
    await Promise.resolve()
    expect(pty.chunks).toEqual(["hi"])
  })
  test("a second tick flushes as its own write", async () => {
    const { session, pty } = makeSession()
    session.writeRaw("ab")
    await Promise.resolve()
    session.writeRaw("c")
    await Promise.resolve()
    expect(pty.chunks).toEqual(["ab", "c"])
  })
})
