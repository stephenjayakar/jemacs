import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import type { FaceName, TextSpan } from "../../src/modes/mode"
import { defineMode, getMode } from "../../src/modes/mode"
import { Keymap, normalizeSequence, type KeyEventLike } from "../../src/kernel/keymap"
import type { Pty } from "../term/pty"
import { makeXTerm, type IBuffer, type IBufferCell, type Terminal as XTerm } from "./xterm-shim"

export { makeXTerm } from "./xterm-shim"

type PtyModule = typeof import("../term/pty")
let ptyModule: PtyModule | null = null

async function loadPtyModule(): Promise<PtyModule> {
  if (!ptyModule) {
    ptyModule = typeof Bun !== "undefined"
      ? await import("../term/pty")
      : await import("../term/pty-stub")
  }
  return ptyModule
}

/** Emacs term-raw-map: every key resolves to term-send-raw; C-c is the only
 *  prefix escape. Installed as overriding-terminal-local-map so nothing falls
 *  through to global editing commands (C-k → kill-line etc.). */
class TermRawMap extends Keymap {
  override get(seq: string): string | undefined {
    const n = normalizeSequence(seq)
    const explicit = super.get(n)
    if (explicit) return explicit
    if (!n || n === "C-c") return undefined
    const toks = n.split(" ")
    // Single key, or any key after the C-c escape (Emacs term-raw-escape-map's
    // default [t] binding) — falling through would self-insert into a read-only
    // buffer. Explicit C-c bindings on this map shadow the fallback.
    if (toks.length === 1 || (toks.length === 2 && toks[0] === "C-c")) return "term-send-raw"
    return undefined
  }
  override hasPrefix(seq: string): boolean {
    return normalizeSequence(seq) === "C-c" || super.hasPrefix(seq)
  }
}
export const termRawMap = new TermRawMap("term-raw-map")
termRawMap.bind("C-c C-c", "term-interrupt")
termRawMap.bind("C-c C-k", "term-kill")
termRawMap.bind("C-c C-s", "term-send-string")
termRawMap.bind("C-c C-j", "term-line-mode")

/** Map a key event to the bytes the pty should receive. */
export function keyToPtyBytes(k: KeyEventLike): string {
  if (k.sequence) return k.sequence
  if (k.name === "space") return " "
  if (k.name === "enter" || k.name === "return") return "\r"
  return k.raw ?? k.name
}

export type TermSession = {
  pty: Pty
  xt: XTerm
  rows: number
  cols: number
  /** Resolves when every feed() chunk so far has been parsed by xterm and
   *  mirrored into the BufferModel. xt.write is async (setTimeout), so
   *  callers that need to observe the mirror must await this. */
  settled?: Promise<void>
  /** Bytes queued for the next pty.write() flush — see writeRaw(). */
  txBuf?: string
  txScheduled?: boolean
}
export const sessions = new WeakMap<BufferModel, TermSession>()

export const TERM_SPANS_LOCAL = "term-spans"

/** FaceName is a closed union; map the 16-colour ANSI palette onto the closest
 *  existing font-lock faces (same approach as smerge's SMERGE_FACES). */
export const ANSI_FACES: Readonly<Record<number, FaceName>> = {
  0: "comment", 1: "error",  2: "string",   3: "function",
  4: "directory", 5: "type", 6: "constant", 7: "default",
  8: "comment", 9: "error", 10: "string",  11: "function",
  12: "directory", 13: "type", 14: "constant", 15: "default",
}

export function sessionFor(buffer: BufferModel): TermSession | undefined {
  return sessions.get(buffer)
}

/** Register a session against a buffer (spawn path + test injection). */
export function attachSession(buffer: BufferModel, session: TermSession): void {
  sessions.set(buffer, session)
}

/** Push a new geometry to the pty (TIOCSWINSZ ⇒ SIGWINCH to the foreground
 *  group) and to the headless xterm grid, then re-mirror into the BufferModel.
 *  No-ops on unchanged dims so window-configuration-change-hook can fire on
 *  every layout edit without spamming the child. */
export function resizeSession(buffer: BufferModel, rows: number, cols: number): void {
  const s = sessions.get(buffer)
  if (!s || rows < 1 || cols < 1 || (s.rows === rows && s.cols === cols)) return
  s.rows = rows
  s.cols = cols
  s.pty.resize(rows, cols)
  s.xt.resize(cols, rows)
  const { text, point, spans } = renderTerminal(s.xt)
  buffer.setText(text, false)
  buffer.point = point
  buffer.locals.set(TERM_SPANS_LOCAL, spans)
}

export function termSpans(buffer: BufferModel): TextSpan[] {
  return (buffer.locals.get(TERM_SPANS_LOCAL) as TextSpan[] | undefined) ?? []
}

/** Reduce a cell's SGR attributes to a single FaceName, or null for default. */
function cellFace(c: IBufferCell): FaceName | null {
  if (c.isAttributeDefault()) return null
  if (!c.isFgDefault()) {
    // Palette indices 0-15 map via ANSI_FACES; 256-colour and RGB fall back to a
    // visible non-default face so the run is at least distinguishable.
    const idx = c.isFgPalette() ? c.getFgColor() : -1
    return ANSI_FACES[idx] ?? "builtin"
  }
  if (!c.isBgDefault()) return "region"
  if (c.isBold()) return "keyword"
  return null
}

/** Snapshot xterm's active buffer (scrollback + viewport) as text, a cursor
 *  offset, and font-lock spans derived from per-cell SGR attributes. */
export function renderTerminal(xt: XTerm): { text: string; point: number; spans: TextSpan[] } {
  const buf: IBuffer = xt.buffer.active
  const cursorRow = buf.baseY + buf.cursorY
  const lines: string[] = []
  const spans: TextSpan[] = []
  const cell = buf.getNullCell()
  let lastNonEmpty = -1
  let lineStart = 0
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)
    const s = line?.translateToString(true) ?? ""
    lines.push(s)
    if (s.length > 0) lastNonEmpty = y
    // Walk cells to recover SGR runs. `col` tracks the offset into `s` (not the
    // cell index): width-0 trailers contribute nothing, empty width-1 cells are
    // a single space in translateToString.
    let col = 0
    let runFace: FaceName | null = null
    let runStart = 0
    const lineEnd = lineStart + s.length
    for (let x = 0; line && col < s.length; x++) {
      if (!line.getCell(x, cell)) break
      const w = cell.getWidth()
      if (w === 0) continue
      const face = cellFace(cell)
      if (face !== runFace) {
        if (runFace) spans.push({ start: lineStart + runStart, end: Math.min(lineStart + col, lineEnd), face: runFace })
        runFace = face
        runStart = col
      }
      col += cell.getChars().length || 1
    }
    if (runFace) spans.push({ start: lineStart + runStart, end: Math.min(lineStart + col, lineEnd), face: runFace })
    lineStart += s.length + 1
  }
  // Drop blank viewport rows past both the last output and the cursor.
  const keep = Math.max(lastNonEmpty, cursorRow, 0) + 1
  lines.length = keep
  const text = lines.join("\n")
  let point = 0
  for (let y = 0; y < cursorRow; y++) point += (lines[y]?.length ?? 0) + 1
  // cursorX is a cell index; line text is UTF-16 — surrogate pairs and wide
  // glyphs make these diverge, so walk cells to find the string offset.
  const cursorLine = buf.getLine(cursorRow)
  let cx = 0
  for (let x = 0; cursorLine && x < buf.cursorX; x++) {
    if (!cursorLine.getCell(x, cell)) break
    if (cell.getWidth() === 0) continue
    cx += cell.getChars().length || 1
  }
  point += Math.min(cx, lines[cursorRow]?.length ?? 0)
  // Spans for trimmed-away trailing rows would only ever be empty (those rows
  // had length 0), but clamp defensively in case a future caller changes trim.
  return { text, point, spans: spans.filter(sp => sp.start < text.length && sp.start < sp.end) }
}

/** Queue bytes for the pty and flush them as a single write on the next
 *  microtask. pty.write() is fs.write(master, …) — async — and concurrent
 *  fs.write calls to the same fd are not ordered, so a same-tick burst of
 *  one-byte writes (opentui-host fires keypress without awaiting) can land
 *  reordered at the shell (t-9689fb: hello → hlleo). */
export function writeRaw(s: TermSession, bytes: string): void {
  s.txBuf = (s.txBuf ?? "") + bytes
  if (s.txScheduled) return
  s.txScheduled = true
  queueMicrotask(() => {
    s.txScheduled = false
    const buf = s.txBuf
    s.txBuf = ""
    if (buf) s.pty.write(buf)
  })
}

/** Feed pty output through xterm's VT parser, then mirror its grid into the
 *  BufferModel. xt.write parses asynchronously (setTimeout), so the mirror is
 *  chained onto `session.settled`; `done` fires after the buffer reflects
 *  this chunk and is kept for the existing callback-style tests. */
export function feed(session: TermSession, buffer: BufferModel, chunk: string, done?: () => void): void {
  const prev = session.settled ?? Promise.resolve()
  session.settled = prev.then(() => new Promise<void>(resolve => {
    session.xt.write(chunk, () => {
      const { text, point, spans } = renderTerminal(session.xt)
      // Streaming output is the hot path: append the new tail without an undo
      // snapshot. Fall back to a full replace only when VT codes rewrote
      // earlier cells (cursor positioning, erase-line, etc.).
      if (text.startsWith(buffer.text)) buffer.append(text.slice(buffer.text.length))
      else buffer.setText(text, false)
      buffer.point = point
      buffer.locals.set(TERM_SPANS_LOCAL, spans)
      done?.()
      resolve()
    })
  }))
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  // Idempotent re-install: keep an already-registered term-map so a second
  // install() (tests, plugin reload) preserves any extra bindings on it.
  const termMap = getMode("term")?.keymap ?? new Keymap("term-map")
  defineMode({
    name: "term",
    parent: "text",
    keymap: termMap,
    fontLock: termSpans,
  })

  editor.command("term", async ({ editor }) => {
    const shell = process.env.SHELL ?? "bash"
    const cwd = editor.currentBuffer.directory?.() ?? process.cwd()
    const buffer = editor.scratch(`*term*<${shell}>`, "")
    buffer.mode = "term"
    const rows = 30, cols = 100
    const { spawnPty } = await loadPtyModule()
    const pty = spawnPty([shell, "-i"], { cwd, rows, cols })
    const session: TermSession = { pty, xt: makeXTerm(rows, cols), rows, cols }
    attachSession(buffer, session)
    pty.onData(chunk => {
      feed(session, buffer, chunk)
      // Anchor the redraw to the (async) mirror instead of voiding it; the
      // next chunk's feed() then waits for this changed() to settle too.
      session.settled = session.settled!.then(() => editor.changed("term-output"))
    })
    pty.onExit(code => {
      buffer.append(`\n[process exited ${code}]\n`)
      session.xt.dispose()
      sessions.delete(buffer)
      // The override is editor-global; drop it whenever *this* term installed it,
      // even if the user has since clicked into another window (t-f2e861cb).
      if (editor.overridingTerminalLocalMap === termRawMap) editor.overridingTerminalLocalMap = null
      if (editor.currentBuffer === buffer) void editor.run("term-line-mode")
      void editor.changed("term-exit")
    })
    await editor.run("term-char-mode")
    editor.message(`term: ${shell} (pid ${pty.pid})`)
  }, "Spawn an interactive shell in a *term* buffer (v2: @xterm/headless VT parser).")

  editor.command("term-char-mode", ({ buffer, editor }) => {
    if (!sessions.has(buffer)) return editor.message("No term session")
    buffer.readOnly = true
    editor.overridingTerminalLocalMap = termRawMap
  })

  editor.command("term-line-mode", ({ buffer, editor }) => {
    buffer.readOnly = false
    editor.overridingTerminalLocalMap = null
  })

  // Universal escape: a stuck term override soft-locks the whole editor, so
  // keyboard-quit must always be able to tear it down (t-f2e861cb).
  ctx.advice("keyboard-quit", {
    after: ({ editor }) => {
      if (editor.overridingTerminalLocalMap === termRawMap) editor.overridingTerminalLocalMap = null
    },
  })

  editor.command("term-send-raw", ({ buffer, editor, args, keyEvent }) => {
    // ctx.keyEvent is captured at dispatch; editor.lastKeyEvent can already be
    // the *next* key under rapid input (t-414394c1). Fallback covers M-x.
    const k = keyEvent ?? editor.lastKeyEvent
    const s = sessions.get(buffer)
    if (!s) return editor.message("No term session")
    const bytes = args[0] ?? (k ? keyToPtyBytes(k) : null)
    if (bytes != null) writeRaw(s, bytes)
  })

  editor.command("term-send-string", async ({ buffer, editor }) => {
    const s = sessions.get(buffer)
    if (!s) return editor.message("No term session")
    const str = await editor.prompt("Send: ")
    if (str != null) writeRaw(s, str + "\r")
  })

  editor.command("term-interrupt", ({ buffer }) => {
    const s = sessions.get(buffer)
    if (s) writeRaw(s, "\x03")
  })
  editor.command("term-kill", ({ buffer }) => sessions.get(buffer)?.pty.kill())

  // Keep the pty's winsize in sync with the displaying window. The display
  // layer stashes the leaf's body geometry on the buffer before firing the
  // hook (Emacs convention: window-configuration-change-hook is buffer-local).
  ctx.hook("window-configuration-change-hook", ({ buffer }) => {
    if (!sessions.has(buffer)) return
    const rows = buffer.locals.get("window-body-rows") as number | undefined
    const cols = buffer.locals.get("window-body-cols") as number | undefined
    if (rows && cols) resizeSession(buffer, rows, cols)
  })

  // Char-mode: every printable key goes raw; C-c is the prefix. Uppercase
  // arrives as S-<letter>; space must be the named token (a literal " "
  // normalizes to the empty sequence and never matches).
  const lower = "abcdefghijklmnopqrstuvwxyz".split("")
  const punct = `!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`.split("")
  for (const k of [...lower, ...lower.map(c => `S-${c}`), ..."0123456789", ...punct,
                   "space", "enter", "backspace", "tab", "up", "down", "left", "right"]) {
    editor.defineKey("term-map", k, "term-send-raw")
  }
  editor.defineKey("term-map", "C-c C-c", "term-interrupt")
  editor.defineKey("term-map", "C-c C-k", "term-kill")
  editor.defineKey("term-map", "C-c C-s", "term-send-string")
  editor.defineKey("term-map", "C-c C-j", "term-line-mode")
}
