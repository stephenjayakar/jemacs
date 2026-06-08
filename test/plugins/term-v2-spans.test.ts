import { expect, test, describe } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { modeFeature } from "../../src/modes/mode"
import { makeEditor } from "./helper"
import {
  install,
  feed,
  renderTerminal,
  makeXTerm,
  termSpans,
  ANSI_FACES,
  TERM_SPANS_LOCAL,
  type TermSession,
} from "../../plugins/term-v2"
import type { Pty } from "../../plugins/term/pty"

function fakePty(): Pty {
  return { pid: 0, write() {}, resize() {}, onData() {}, onExit() {}, kill() {} }
}

function makeSession(rows = 10, cols = 40): { session: TermSession; buffer: BufferModel } {
  const buffer = new BufferModel({ name: "*term*", kind: "scratch" })
  buffer.mode = "term"
  const session: TermSession = { pty: fakePty(), xt: makeXTerm(rows, cols), rows, cols }
  return { session, buffer }
}

function feedAsync(s: TermSession, b: BufferModel, chunk: string): Promise<void> {
  return new Promise(resolve => feed(s, b, chunk, resolve))
}

function writeAsync(xt: ReturnType<typeof makeXTerm>, chunk: string): Promise<void> {
  return new Promise(resolve => xt.write(chunk, resolve))
}

describe("term-v2: SGR → TextSpan", () => {
  test("renderTerminal emits a span per coloured run", async () => {
    const xt = makeXTerm(5, 40)
    await writeAsync(xt, "plain \x1b[31mred\x1b[0m \x1b[32mgreen\x1b[0m tail")
    const { text, spans } = renderTerminal(xt)
    expect(text).toBe("plain red green tail")
    // Exactly the two coloured words are spanned; default text is left bare.
    expect(spans).toEqual([
      { start: 6, end: 9, face: ANSI_FACES[1] },   // "red"
      { start: 10, end: 15, face: ANSI_FACES[2] }, // "green"
    ])
  })

  test("adjacent same-colour cells coalesce; bright variants map to base face", async () => {
    const xt = makeXTerm(5, 40)
    await writeAsync(xt, "\x1b[34mblue\x1b[94mBLUE\x1b[0m")
    const { text, spans } = renderTerminal(xt)
    expect(text).toBe("blueBLUE")
    expect(spans).toEqual([{ start: 0, end: 8, face: ANSI_FACES[4] }])
  })

  test("bold-only and bg-only map to keyword/region faces", async () => {
    const xt = makeXTerm(5, 40)
    await writeAsync(xt, "\x1b[1mbold\x1b[0m \x1b[44mbg\x1b[0m")
    const { text, spans } = renderTerminal(xt)
    expect(text).toBe("bold bg")
    expect(spans).toEqual([
      { start: 0, end: 4, face: "keyword" },
      { start: 5, end: 7, face: "region" },
    ])
  })

  test("span offsets are correct across multiple lines", async () => {
    const xt = makeXTerm(5, 40)
    await writeAsync(xt, "line0\r\n--\x1b[31mERR\x1b[0m--\r\n")
    const { text, spans } = renderTerminal(xt)
    expect(text).toBe("line0\n--ERR--\n")
    expect(spans).toHaveLength(1)
    const sp = spans[0]!
    expect(text.slice(sp.start, sp.end)).toBe("ERR")
    expect(sp.face).toBe(ANSI_FACES[1])
  })

  test("feed() stashes spans in buffer.locals[term-spans]", async () => {
    const { session, buffer } = makeSession()
    expect(termSpans(buffer)).toEqual([])
    await feedAsync(session, buffer, "$ \x1b[32mok\x1b[0m\r\n")
    expect(buffer.text).toBe("$ ok\n")
    const spans = termSpans(buffer)
    expect(spans).toEqual([{ start: 2, end: 4, face: ANSI_FACES[2] }])
    expect(buffer.locals.get(TERM_SPANS_LOCAL)).toBe(spans)
  })

  test("term mode fontLock returns the stored spans (display-model wiring)", async () => {
    const editor = makeEditor()
    install(editor)
    const { session, buffer } = makeSession()
    await feedAsync(session, buffer, "\x1b[31mred\x1b[0m\r\n")
    const fontLock = modeFeature("term", "fontLock")
    expect(fontLock).toBeDefined()
    expect(fontLock!(buffer)).toEqual([{ start: 0, end: 3, face: ANSI_FACES[1] }])
    expect(editor.fontLock(buffer)).toEqual([{ start: 0, end: 3, face: ANSI_FACES[1] }])
  })

  test("256-colour / truecolor fall back to a visible face", async () => {
    const xt = makeXTerm(5, 40)
    await writeAsync(xt, "\x1b[38;5;208mhi\x1b[0m \x1b[38;2;10;20;30mrgb\x1b[0m")
    const { spans } = renderTerminal(xt)
    expect(spans.map(s => s.face)).toEqual(["builtin", "builtin"])
  })

  // Cell index ≠ UTF-16 offset: a CJK ideograph occupies two cells (width-2 +
  // a width-0 trailer) but one UTF-16 unit; an emoji surrogate pair is one
  // cell but two UTF-16 units. renderTerminal must walk getChars().length to
  // recover string offsets — using the cell index would put span.end inside
  // the wrong codepoint and text.slice would no longer equal the coloured run.
  test("span offsets are UTF-16, not cell indices — CJK wide glyphs", async () => {
    const xt = makeXTerm(5, 40)
    await writeAsync(xt, "a\x1b[31m日本\x1b[0m b")
    const { text, spans } = renderTerminal(xt)
    expect(text).toBe("a日本 b")
    expect(spans).toHaveLength(1)
    // 日本 spans cells 1..5 but UTF-16 offsets 1..3.
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe("日本")
    expect(spans[0]).toEqual({ start: 1, end: 3, face: ANSI_FACES[1] })
  })

  test("span offsets are UTF-16, not cell indices — emoji surrogate pairs", async () => {
    const xt = makeXTerm(5, 40)
    await writeAsync(xt, "a\x1b[32m👋👋\x1b[0m b")
    const { text, spans } = renderTerminal(xt)
    expect(text).toBe("a👋👋 b")
    expect(spans).toHaveLength(1)
    // Each 👋 is one cell but two UTF-16 units (surrogate pair).
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe("👋👋")
    expect(spans[0]).toEqual({ start: 1, end: 5, face: ANSI_FACES[2] })
  })

  test("point maps cursorX (cell index) to a UTF-16 offset — surrogate pair", async () => {
    const xt = makeXTerm(5, 40)
    await writeAsync(xt, "👋x")
    await writeAsync(xt, "\x1b[1;3H") // CUP: col 3 ⇒ cursorX 2, past 'x'
    const { text, point } = renderTerminal(xt)
    expect(text).toBe("👋x")
    expect(xt.buffer.active.cursorX).toBe(2)
    // "👋x".length is 3; point must be the UTF-16 offset (3), not cursorX (2),
    // which would land mid-surrogate-pair / before 'x'.
    expect(point).toBe(3)
    expect(point).not.toBe(xt.buffer.active.cursorX)
  })

  test("point maps cursorX (cell index) to a UTF-16 offset — CJK wide glyph", async () => {
    const xt = makeXTerm(5, 40)
    await writeAsync(xt, "日本x")
    await writeAsync(xt, "\x1b[1;5H") // CUP: col 5 ⇒ cursorX 4, on 'x'
    const { text, point } = renderTerminal(xt)
    expect(text).toBe("日本x")
    expect(xt.buffer.active.cursorX).toBe(4)
    // 'x' is at UTF-16 offset 2; cursorX 4 would overshoot the 3-unit string.
    expect(text[point]).toBe("x")
    expect(point).toBe(2)
  })
})
