import { expect, test, describe } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { getMode } from "../../src/modes/mode"
import { makeEditor } from "./helper"
import {
  install,
  feed,
  renderTerminal,
  makeXTerm,
  keyToPtyBytes,
  writeRaw,
  type TermSession,
} from "../../plugins/term-v2"
import type { Pty } from "../../plugins/term/pty"

function fakePty(): Pty & { sent: string; writes: string[] } {
  const writes: string[] = []
  return {
    pid: 0,
    writes,
    get sent() { return writes.join("") },
    write(d) { writes.push(d) },
    resize() {},
    onData() {},
    onExit() {},
    kill() {},
  }
}

function makeSession(rows = 10, cols = 40): { session: TermSession; buffer: BufferModel; pty: ReturnType<typeof fakePty> } {
  const buffer = new BufferModel({ name: "*term*", kind: "scratch" })
  const pty = fakePty()
  const session: TermSession = { pty, xt: makeXTerm(rows, cols), rows, cols }
  return { session, buffer, pty }
}

/** xterm.write is async; wrap feed() so tests can await the parse. */
function feedAsync(s: TermSession, b: BufferModel, chunk: string): Promise<void> {
  return new Promise(resolve => feed(s, b, chunk, resolve))
}

describe("term-v2: VT parsing via @xterm/headless", () => {
  test("plain output with CRLF renders as lines; point follows cursor", async () => {
    const { session, buffer } = makeSession()
    await feedAsync(session, buffer, "hello\r\nworld\r\n$ ")
    expect(buffer.text).toBe("hello\nworld\n$ ")
    expect(buffer.point).toBe(buffer.text.length)
  })

  test("SGR color codes are consumed, not leaked into buffer text", async () => {
    const { session, buffer } = makeSession()
    await feedAsync(session, buffer, "plain \x1b[31mred\x1b[0m \x1b[1;32mbold-green\x1b[0m\r\n")
    expect(buffer.text).toBe("plain red bold-green\n")
    expect(buffer.text).not.toContain("\x1b")
    expect(buffer.text).not.toContain("[31m")
  })

  test("absolute cursor positioning (CSI H) overwrites grid cells", async () => {
    const { session, buffer } = makeSession()
    await feedAsync(session, buffer, "AAAAA\r\nBBBBB\r\nCCCCC")
    // Move to row 2 col 2 (1-based), write XX
    await feedAsync(session, buffer, "\x1b[2;2HXX")
    expect(buffer.text.split("\n")[1]).toBe("BXXBB")
    // Point sits where the cursor stopped: row 2 (index 1), col 4 (index 3)
    expect(buffer.point).toBe("AAAAA\n".length + 3)
  })

  test("erase-to-end-of-line (CSI K) and CR redraw a prompt in place", async () => {
    const { session, buffer } = makeSession()
    await feedAsync(session, buffer, "$ old-command-here")
    await feedAsync(session, buffer, "\r\x1b[K$ new")
    expect(buffer.text).toBe("$ new")
    expect(buffer.point).toBe(5)
  })

  test("cursor save/restore (DECSC/DECRC) round-trips position", async () => {
    const { session, buffer } = makeSession()
    await feedAsync(session, buffer, "0123456789")
    // save, jump home, write 'ab', restore, write 'Z'
    await feedAsync(session, buffer, "\x1b7\x1b[1;1Hab\x1b8Z")
    expect(buffer.text).toBe("ab23456789Z")
    expect(buffer.point).toBe(11)
  })

  test("scrollback is preserved past viewport height", async () => {
    const { session, buffer } = makeSession(4, 40)
    let out = ""
    for (let i = 0; i < 8; i++) out += `line${i}\r\n`
    await feedAsync(session, buffer, out)
    const lines = buffer.text.split("\n")
    expect(lines[0]).toBe("line0")
    expect(lines[7]).toBe("line7")
    expect(lines.length).toBe(9) // 8 lines + trailing empty cursor row
  })

  test("OSC title sequence is swallowed", async () => {
    const { session, buffer } = makeSession()
    await feedAsync(session, buffer, "\x1b]0;my title\x07$ ")
    expect(buffer.text).toBe("$ ")
  })

  test("split escape sequence across two chunks still parses", async () => {
    const { session, buffer } = makeSession()
    await feedAsync(session, buffer, "before \x1b[")
    await feedAsync(session, buffer, "31mred\x1b[0m after")
    expect(buffer.text).toBe("before red after")
  })
})

describe("term-v2: renderTerminal", () => {
  test("trims blank viewport rows past the cursor", () => {
    const xt = makeXTerm(10, 40)
    return new Promise<void>(done => {
      xt.write("a\r\nb", () => {
        const { text, point } = renderTerminal(xt)
        expect(text).toBe("a\nb")
        expect(point).toBe(3)
        done()
      })
    })
  })
})

describe("term-v2: writeRaw microtask batching", () => {
  // t-9689fb's fix lives in writeRaw, but loop-t-9689fb.test.ts only drives it
  // through term-send-raw. Pin the contract directly so an eager-flush refactor
  // can't slip past the e2e test on favourable scheduling.
  test("same-tick writes coalesce into one pty.write on the next microtask", async () => {
    const { session, pty } = makeSession()
    writeRaw(session, "h")
    writeRaw(session, "i")
    expect(pty.writes).toEqual([])
    await Promise.resolve()
    expect(pty.writes).toEqual(["hi"])
  })

  test("a second tick flushes as its own write", async () => {
    const { session, pty } = makeSession()
    writeRaw(session, "ab")
    await Promise.resolve()
    writeRaw(session, "c")
    await Promise.resolve()
    expect(pty.writes).toEqual(["ab", "c"])
  })
})

describe("term-v2: keyToPtyBytes (kept from v1)", () => {
  test("printable chars pass through via sequence", () => {
    expect(keyToPtyBytes({ name: "a", sequence: "a" })).toBe("a")
    expect(keyToPtyBytes({ name: "/", sequence: "/" })).toBe("/")
  })
  test("named keys map to control bytes", () => {
    expect(keyToPtyBytes({ name: "return" })).toBe("\r")
    expect(keyToPtyBytes({ name: "enter" })).toBe("\r")
    expect(keyToPtyBytes({ name: "space" })).toBe(" ")
  })
  test("falls back to raw escape for arrows", () => {
    expect(keyToPtyBytes({ name: "up", raw: "\x1b[A" })).toBe("\x1b[A")
  })
})

describe("term-v2: install wiring", () => {
  test("registers term commands and char-mode keymap", () => {
    const editor = makeEditor()
    install(editor)
    expect(editor.commands.get("term")).toBeDefined()
    expect(editor.commands.get("term-send-raw")).toBeDefined()
    expect(editor.commands.get("term-interrupt")).toBeDefined()
    const map = getMode("term")?.keymap
    expect(map?.get("a")).toBe("term-send-raw")
    expect(map?.get("C-c C-c")).toBe("term-interrupt")
  })
})
