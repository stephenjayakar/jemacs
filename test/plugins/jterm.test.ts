import { expect, test, describe, beforeEach } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { TERMINAL_SURFACE_LOCAL } from "../../src/display/terminal-surface"
import { getMode } from "../../src/modes/mode"
import { setCustom } from "../../src/runtime/custom"
import { currentKill } from "../../src/runtime/kill-ring"
import {
  install,
  makeXTerm,
  sessions,
  jtermRawMap,
  JTermSession,
  jtermSpans,
  sessionFor,
  surfaceChanged,
} from "../../plugins/jterm"
import type { Pty } from "../../plugins/term/pty"
import { makeEditor } from "./helper"
import { keyToPtyBytes } from "../../plugins/jterm/key-encode"

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

function makeSession(rows = 4, cols = 20): { session: JTermSession; buffer: BufferModel; pty: ReturnType<typeof fakePty> } {
  const editor = makeEditor()
  const buffer = new BufferModel({ name: "*jterm*", kind: "scratch" })
  const pty = fakePty()
  const xt = makeXTerm(rows, cols)
  const session = new JTermSession(editor, buffer, pty, xt, rows, cols, "jterm")
  return { session, buffer, pty }
}

function feedAsync(s: JTermSession, _b: BufferModel, chunk: string): Promise<void> {
  return s.feed(chunk)
}

describe("jterm: install wiring", () => {
  test("registers Emacs-style commands and the jterm-mode keymap", () => {
    const editor = makeEditor()
    install(editor)

    // Top-level entry points
    expect(editor.commands.get("jterm")).toBeDefined()
    expect(editor.commands.get("shell")).toBeDefined()
    expect(editor.commands.get("jterm-run-command")).toBeDefined()
    expect(editor.commands.get("opencode")).toBeDefined()

    // char-mode / copy-mode toggle
    expect(editor.commands.get("jterm-char-mode")).toBeDefined()
    expect(editor.commands.get("jterm-copy-mode")).toBeDefined()
    expect(editor.commands.get("jterm-copy-mode-done")).toBeDefined()
    expect(editor.commands.get("jterm-clear-scrollback")).toBeDefined()
    expect(editor.commands.get("jterm-reset-cursor-point")).toBeDefined()

    // send / interrupt / kill / clear / reset
    expect(editor.commands.get("jterm-send-raw")).toBeDefined()
    expect(editor.commands.get("jterm-send-string")).toBeDefined()
    expect(editor.commands.get("jterm-interrupt")).toBeDefined()
    expect(editor.commands.get("jterm-kill")).toBeDefined()
    expect(editor.commands.get("jterm-clear")).toBeDefined()
    expect(editor.commands.get("jterm-reset")).toBeDefined()
    expect(editor.commands.get("jterm-yank")).toBeDefined()
    expect(editor.commands.get("tui-term")).toBeUndefined()
    expect(editor.commands.get("tui-term-send-raw")).toBeUndefined()
    expect(editor.commands.get("tui-term-char-mode")).toBeUndefined()

    // Mode is registered
    const map = getMode("jterm-mode")?.keymap
    expect(map).toBeDefined()
    expect(map?.get("a")).toBeUndefined()
    expect(map?.get("C-c C-c")).toBe("jterm-interrupt")
    expect(map?.get("C-c C-t")).toBe("jterm-copy-mode")
    expect(map?.get("C-c C-l")).toBe("jterm-clear-scrollback")
    const copyMap = getMode("jterm-copy-mode")?.keymap
    expect(copyMap?.get("RET")).toBe("jterm-copy-mode-done")
    expect(copyMap?.get("C-a")).toBe("jterm-beginning-of-line")
  })

  test("does not collide with term-v2 commands", () => {
    // The two plugins are independent. term-v2 binds term-send-raw; jterm
    // binds jterm-send-raw. Both should coexist.
    const editor = makeEditor()
    install(editor)
    expect(editor.commands.get("jterm-send-raw")).toBeDefined()
    expect(editor.commands.get("jterm-interrupt")).toBeDefined()
  })
})

describe("jterm: char-mode / copy-mode", () => {
  test("char-mode sets read-only + raw keymap + paste-handler", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*jterm*", "", "jterm-mode")
    const pty = fakePty()
    const session = new JTermSession(editor, buffer, pty, makeXTerm(4, 20), 4, 20, "jterm")
    sessions.set(buffer, session)

    await editor.run("jterm-char-mode")
    expect(buffer.readOnly).toBe(true)
    expect(editor.overridingTerminalLocalMap).toBe(jtermRawMap)
    expect(buffer.locals.has("paste-handler")).toBe(true)
    expect(session.charMode).toBe(true)
  })

  test("copy-mode uses read-only text mirror + copy keymap", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*jterm*", "", "jterm-mode")
    const pty = fakePty()
    const session = new JTermSession(editor, buffer, pty, makeXTerm(4, 20), 4, 20, "jterm")
    sessions.set(buffer, session)

    await editor.run("jterm-char-mode")
    expect(buffer.readOnly).toBe(true)

    await editor.run("jterm-copy-mode")
    expect(buffer.readOnly).toBe(true)
    expect(buffer.mode).toBe("jterm-copy-mode")
    expect(editor.overridingTerminalLocalMap).toBeNull()
    expect(buffer.locals.has("paste-handler")).toBe(false)
    expect(buffer.locals.get(TERMINAL_SURFACE_LOCAL)).toBeUndefined()
    expect(session.charMode).toBe(false)
  })

  test("copy-mode toggles back to char-mode on C-c C-t", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*jterm*", "", "jterm-mode")
    const pty = fakePty()
    sessions.set(buffer, new JTermSession(editor, buffer, pty, makeXTerm(4, 20), 4, 20, "jterm"))

    await editor.run("jterm-char-mode")
    await editor.handleKey({ name: "c", ctrl: true, sequence: "\x03" })
    await editor.handleKey({ name: "t", ctrl: true, sequence: "\x14" })
    expect(buffer.mode).toBe("jterm-copy-mode")
    expect(editor.overridingTerminalLocalMap).toBeNull()

    await editor.handleKey({ name: "c", ctrl: true, sequence: "\x03" })
    await editor.handleKey({ name: "t", ctrl: true, sequence: "\x14" })
    expect(buffer.mode).toBe("jterm-mode")
    expect(editor.overridingTerminalLocalMap).toBe(jtermRawMap)
  })

  test("copy-mode done copies region or line and returns to char-mode", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*jterm*", "alpha\nbeta", "jterm-mode")
    sessions.set(buffer, new JTermSession(editor, buffer, fakePty(), makeXTerm(4, 20), 4, 20, "jterm"))

    await editor.run("jterm-char-mode")
    await editor.run("jterm-copy-mode")
    buffer.point = 0
    buffer.setMark()
    buffer.point = 5
    await editor.run("jterm-copy-mode-done")

    expect(currentKill(editor)).toBe("alpha")
    expect(buffer.mode).toBe("jterm-mode")
    expect(editor.overridingTerminalLocalMap).toBe(jtermRawMap)
  })

  test("keyboard-quit tears down the char-mode override", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*jterm*", "", "jterm-mode")
    sessions.set(buffer, new JTermSession(editor, buffer, fakePty(), makeXTerm(4, 20), 4, 20, "jterm"))

    await editor.run("jterm-char-mode")
    expect(editor.overridingTerminalLocalMap).toBe(jtermRawMap)

    await editor.run("keyboard-quit")
    expect(editor.overridingTerminalLocalMap).toBeNull()
  })

  test("char-mode without a session is a no-op (no crash)", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*unrelated*", "", "text")
    editor.switchToBuffer(buffer.id)
    await editor.run("jterm-char-mode")
    // No session attached → command short-circuits with a message.
    expect(buffer.readOnly).toBe(false)
    expect(editor.overridingTerminalLocalMap).toBeNull()
  })

  test("real handleKey path sends typed keys to the pty in char-mode", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*jterm*", "", "jterm-mode")
    const pty = fakePty()
    sessions.set(buffer, new JTermSession(editor, buffer, pty, makeXTerm(4, 20), 4, 20, "jterm"))

    await editor.run("jterm-char-mode")
    await editor.handleKey({ name: "l", sequence: "l" })
    await editor.handleKey({ name: "s", sequence: "s" })
    await editor.handleKey({ name: "return" })
    await Promise.resolve()

    expect(pty.sent).toBe("ls\r")
  })
})

describe("jterm: paste routing via buffer.locals['paste-handler']", () => {
  test("paste-handler installed by char-mode writes to the pty", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*jterm*", "", "jterm-mode")
    const pty = fakePty()
    sessions.set(buffer, new JTermSession(editor, buffer, pty, makeXTerm(4, 20), 4, 20, "jterm"))

    await editor.run("jterm-char-mode")
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
    const buffer = editor.scratch("*jterm*", "", "jterm-mode")
    const pty = fakePty()
    sessions.set(buffer, new JTermSession(editor, buffer, pty, makeXTerm(4, 20), 4, 20, "jterm"))

    await editor.run("jterm-char-mode")
    const handler = buffer.locals.get("paste-handler") as (text: string) => void
    handler("ignore me")
    await Promise.resolve()
    // The buffer text was never inserted into.
    expect(buffer.text).toBe("")
  })

  test("disabling bracketed-paste sends raw bytes", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*jterm*", "", "jterm-mode")
    const pty = fakePty()
    sessions.set(buffer, new JTermSession(editor, buffer, pty, makeXTerm(4, 20), 4, 20, "jterm"))

    await editor.run("jterm-char-mode")
    setCustom("jterm-bracketed-paste", false)
    try {
      const handler = buffer.locals.get("paste-handler") as (text: string) => void
      handler("ls -la")
      await Promise.resolve()
      expect(pty.chunks[0]).toBe("ls -la")
    } finally {
      setCustom("jterm-bracketed-paste", true)
    }
  })
})

describe("jterm: kill-emacs-hook and kill-buffer-hook", () => {
  test("kill-emacs-hook kills all live PTY processes", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*jterm*", "", "jterm-mode")
    const pty = fakePty()
    let killed = false
    pty.kill = () => { killed = true }
    sessions.set(buffer, new JTermSession(editor, buffer, pty, makeXTerm(4, 20), 4, 20, "jterm"))

    // kill-emacs-hook fires from editor.quit(); runHook("kill-emacs-hook") is
    // the same path the test harness can take.
    await editor.runHook("kill-emacs-hook", editor.currentBuffer)
    expect(killed).toBe(true)
  })

  test("kill-buffer-hook disposes the session for the killed buffer", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*jterm*", "", "jterm-mode")
    const pty = fakePty()
    let killed = false
    pty.kill = () => { killed = true }
    sessions.set(buffer, new JTermSession(editor, buffer, pty, makeXTerm(4, 20), 4, 20, "jterm"))

    editor.killBuffer(buffer.id)
    expect(killed).toBe(true)
    expect(sessionFor(buffer)).toBeUndefined()
  })
})

describe("jterm: keyToPtyBytes (kept from term-v2 + extended)", () => {
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

describe("jterm: surfaceChanged (cell-level diff)", () => {
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

describe("jterm: VT parsing via @xterm/headless", () => {
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
    expect(jtermSpans(buffer)).toEqual([
      { start: 6, end: 9, face: "default", style: { fg: "#cd3131" } },
      { start: 10, end: 20, face: "default", style: { fg: "#0dbc79", bold: true } },
    ])
  })
  test("absolute cursor positioning overwrites grid cells", async () => {
    const { session, buffer } = makeSession()
    await feedAsync(session, buffer, "AAAAA\r\nBBBBB\r\nCCCCC")
    await feedAsync(session, buffer, "\x1b[2;2HXX")
    expect(buffer.text.split("\n")[1]).toBe("BXXBB")
  })
  test("normal shell output stays on the text mirror in char-mode", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*jterm*", "", "jterm-mode")
    const session = new JTermSession(editor, buffer, fakePty(), makeXTerm(3, 6), 3, 6, "jterm")
    sessions.set(buffer, session)
    await feedAsync(session, buffer, "hi\r\nthere\r\n$ ")
    await editor.run("jterm-char-mode")
    expect(buffer.locals.get(TERMINAL_SURFACE_LOCAL)).toBeUndefined()
    expect(buffer.text).toContain("hi")
    expect(buffer.text).toContain("there")
  })

  test("alternate-screen TUI output installs a terminal surface", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*jterm*", "", "jterm-mode")
    const session = new JTermSession(editor, buffer, fakePty(), makeXTerm(3, 6), 3, 6, "jterm")
    sessions.set(buffer, session)
    await feedAsync(session, buffer, "\x1b[?1049hALT")
    await editor.run("jterm-char-mode")
    const surface = buffer.locals.get(TERMINAL_SURFACE_LOCAL)
    expect(surface).toMatchObject({ kind: "terminal", rows: 3, cols: 6 })
  })
})

describe("jterm: writeRaw microtask batching", () => {
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
