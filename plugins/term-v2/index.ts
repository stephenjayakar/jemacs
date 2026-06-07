import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import type { FaceStyle } from "../../src/display/theme"
import type { FaceName, TextSpan } from "../../src/modes/mode"
import { defineMode, getMode } from "../../src/modes/mode"
import { Keymap, normalizeSequence, type KeyEventLike } from "../../src/kernel/keymap"
import { TERMINAL_SURFACE_LOCAL, type TerminalCell, type TerminalSurfaceModel } from "../../src/display/terminal-surface"
import type { Pty } from "../term/pty"
import { makeXTerm, type IBuffer, type IBufferCell, type Terminal as XTerm } from "./xterm-shim"

export { makeXTerm } from "./xterm-shim"

type PtyModule = typeof import("../term/pty")
let ptyModule: PtyModule | null = null

async function loadPtyModule(): Promise<PtyModule> {
  if (!ptyModule) {
    ptyModule = typeof Bun !== "undefined"
      ? await import("../term/pty")
      : await import("../term/pty-node")
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
  if (k.meta) return "\x1b" + keyToPtyBytes({ ...k, meta: false, sequence: k.name.length === 1 ? k.name : k.sequence })
  if (k.ctrl) {
    const name = k.name.length === 1 ? k.name : k.sequence
    if (name && name.length === 1) {
      if (name === " ") return "\x00"
      if (name === "?") return "\x7f"
      const c = name.toUpperCase().charCodeAt(0)
      if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c & 0x1f)
    }
  }
  if (k.sequence) return k.sequence
  if (k.name === "space") return " "
  if (k.name === "enter" || k.name === "return") return "\r"
  if (k.name === "tab") return "\t"
  if (k.name === "backspace") return "\x7f"
  if (k.name === "delete") return "\x1b[3~"
  if (k.name === "left") return "\x1b[D"
  if (k.name === "right") return "\x1b[C"
  if (k.name === "up") return "\x1b[A"
  if (k.name === "down") return "\x1b[B"
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
export const TERM_SURFACE_ENABLED_LOCAL = "term-surface-enabled"

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
  updateTerminalSurface(buffer, s)
}

export function termSpans(buffer: BufferModel): TextSpan[] {
  return (buffer.locals.get(TERM_SPANS_LOCAL) as TextSpan[] | undefined) ?? []
}

type TerminalRunStyle = { face: FaceName; style: FaceStyle }

/** Reduce a cell's SGR attributes to a display style, or null for default. */
function cellStyle(c: IBufferCell): TerminalRunStyle | null {
  if (c.isAttributeDefault()) return null
  const style: FaceStyle = {}
  if (c.isBold()) style.bold = true
  if (c.isItalic()) style.italic = true
  if (c.isUnderline()) style.underline = true
  if (!c.isFgDefault()) {
    const fg = cellColor(c, "fg")
    if (fg) style.fg = fg
  }
  if (!c.isBgDefault()) {
    const bg = cellColor(c, "bg")
    if (bg) style.bg = bg
  }
  if (!style.fg && !style.bg && !style.bold && !style.italic && !style.underline) return null
  return { face: "default", style }
}

function sameRunStyle(a: TerminalRunStyle | null, b: TerminalRunStyle | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.face === b.face
    && a.style.fg === b.style.fg
    && a.style.bg === b.style.bg
    && !!a.style.bold === !!b.style.bold
    && !!a.style.italic === !!b.style.italic
    && !!a.style.underline === !!b.style.underline
}

function spanForRun(start: number, end: number, run: TerminalRunStyle): TextSpan {
  return { start, end, face: run.face, style: run.style }
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
    let runStyle: TerminalRunStyle | null = null
    let runStart = 0
    const lineEnd = lineStart + s.length
    for (let x = 0; line && col < s.length; x++) {
      if (!line.getCell(x, cell)) break
      const w = cell.getWidth()
      if (w === 0) continue
      const style = cellStyle(cell)
      if (!sameRunStyle(style, runStyle)) {
        if (runStyle) spans.push(spanForRun(lineStart + runStart, Math.min(lineStart + col, lineEnd), runStyle))
        runStyle = style
        runStart = col
      }
      col += cell.getChars().length || 1
    }
    if (runStyle) spans.push(spanForRun(lineStart + runStart, Math.min(lineStart + col, lineEnd), runStyle))
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

export function renderTerminalSurface(xt: XTerm): TerminalSurfaceModel {
  const buf: IBuffer = xt.buffer.active
  const rows = xt.rows
  const cols = xt.cols
  const cells: TerminalCell[][] = []
  const scratch = buf.getNullCell()
  for (let y = 0; y < rows; y++) {
    const row: TerminalCell[] = []
    const line = buf.getLine(buf.baseY + y)
    for (let x = 0; x < cols; x++) {
      if (!line?.getCell(x, scratch) || scratch.getWidth() === 0) {
        row.push({ text: " " })
        continue
      }
      row.push(cellToTerminalCell(scratch))
    }
    cells.push(row)
  }
  return {
    kind: "terminal",
    rows,
    cols,
    cursorRow: Math.max(0, Math.min(rows - 1, buf.cursorY)),
    cursorCol: Math.max(0, Math.min(cols - 1, buf.cursorX)),
    cells,
  }
}

function updateTerminalSurface(buffer: BufferModel, session: TermSession): void {
  if (!session.xt) return
  if (buffer.locals.get(TERM_SURFACE_ENABLED_LOCAL) === false) {
    buffer.locals.delete(TERMINAL_SURFACE_LOCAL)
    return
  }
  buffer.locals.set(TERMINAL_SURFACE_LOCAL, renderTerminalSurface(session.xt))
}

function cellToTerminalCell(cell: IBufferCell): TerminalCell {
  const out: TerminalCell = {
    text: cell.getChars() || " ",
  }
  if (cell.isBold()) out.bold = true
  if (cell.isItalic()) out.italic = true
  if (cell.isUnderline()) out.underline = true
  const fg = cellColor(cell, "fg")
  const bg = cellColor(cell, "bg")
  if (fg) out.fg = fg
  if (bg) out.bg = bg
  return out
}

function cellColor(cell: IBufferCell, part: "fg" | "bg"): string | undefined {
  const c = cell as IBufferCell & {
    isFgRGB?: () => boolean
    isBgRGB?: () => boolean
    isFgPalette?: () => boolean
    isBgPalette?: () => boolean
    isFgDefault?: () => boolean
    isBgDefault?: () => boolean
    getFgColor?: () => number
    getBgColor?: () => number
  }
  const isDefault = part === "fg" ? c.isFgDefault?.() : c.isBgDefault?.()
  if (isDefault !== false) return undefined
  const isRgb = part === "fg" ? c.isFgRGB?.() : c.isBgRGB?.()
  const isPalette = part === "fg" ? c.isFgPalette?.() : c.isBgPalette?.()
  const value = part === "fg" ? c.getFgColor?.() : c.getBgColor?.()
  if (value == null) return undefined
  if (isRgb) return rgbHex(value)
  if (isPalette) return xtermPalette(value)
  return undefined
}

function rgbHex(value: number): string {
  return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`
}

const ANSI_HEX = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
]

function xtermPalette(index: number): string | undefined {
  if (index >= 0 && index < ANSI_HEX.length) return ANSI_HEX[index]
  if (index >= 16 && index <= 231) {
    const n = index - 16
    const r = Math.floor(n / 36)
    const g = Math.floor((n % 36) / 6)
    const b = n % 6
    return rgbTripletHex(cubeLevel(r), cubeLevel(g), cubeLevel(b))
  }
  if (index >= 232 && index <= 255) {
    const v = 8 + (index - 232) * 10
    return rgbTripletHex(v, v, v)
  }
  return undefined
}

function cubeLevel(n: number): number {
  return n === 0 ? 0 : 55 + n * 40
}

function rgbTripletHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`
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
      updateTerminalSurface(buffer, session)
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

  const vtermMap = getMode("vterm")?.keymap ?? new Keymap("vterm-map")
  defineMode({
    name: "vterm",
    parent: "text",
    keymap: vtermMap,
    fontLock: termSpans,
  })

  async function spawnTerminalBuffer(options: {
    argv: string[]
    name: string
    mode: "term" | "vterm"
    cwd?: string
    env?: Record<string, string>
  }): Promise<BufferModel> {
    const cwd = options.cwd ?? editor.currentBuffer.directory?.() ?? process.cwd()
    const buffer = editor.scratch(options.name, "", options.mode)
    buffer.mode = options.mode
    buffer.locals.set(TERM_SURFACE_ENABLED_LOCAL, true)
    const rows = (buffer.locals.get("window-body-rows") as number | undefined) ?? 30
    const cols = (buffer.locals.get("window-body-cols") as number | undefined) ?? 100
    const { spawnPty } = await loadPtyModule()
    const pty = spawnPty(options.argv, { cwd, rows, cols, env: options.env })
    const session: TermSession = { pty, xt: makeXTerm(rows, cols), rows, cols }
    attachSession(buffer, session)
    updateTerminalSurface(buffer, session)
    pty.onData(chunk => {
      void editor.events.emit("terminalData", { bufferId: buffer.id, data: chunk })
      feed(session, buffer, chunk)
      // Anchor the redraw to the (async) mirror instead of voiding it; the
      // next chunk's feed() then waits for this changed() to settle too.
      session.settled = session.settled!.then(() => editor.changed(`${options.mode}-output`))
    })
    pty.onExit(code => {
      buffer.locals.delete(TERMINAL_SURFACE_LOCAL)
      buffer.append(`\n[process exited ${code}]\n`)
      session.xt.dispose()
      sessions.delete(buffer)
      // The override is editor-global; drop it whenever *this* term installed it,
      // even if the user has since clicked into another window (t-f2e861cb).
      if (editor.overridingTerminalLocalMap === termRawMap) editor.overridingTerminalLocalMap = null
      if (editor.currentBuffer === buffer) void editor.run(options.mode === "vterm" ? "vterm-copy-mode" : "term-line-mode")
      void editor.changed(`${options.mode}-exit`)
    })
    await editor.run(options.mode === "vterm" ? "vterm-char-mode" : "term-char-mode")
    editor.message(`${options.mode}: ${options.argv.join(" ")} (pid ${pty.pid})`)
    return buffer
  }

  editor.command("term", async ({ editor }) => {
    const shell = process.env.SHELL ?? "bash"
    await spawnTerminalBuffer({ argv: [shell, "-i"], name: `*term*<${shell}>`, mode: "term" })
  }, "Spawn an interactive shell in a *term* buffer (v2: @xterm/headless VT parser).")

  editor.command("vterm", async ({ editor }) => {
    const shell = process.env.SHELL ?? "bash"
    await spawnTerminalBuffer({ argv: [shell, "-i"], name: `*vterm*<${shell}>`, mode: "vterm" })
  }, "Spawn an interactive shell in a vterm buffer.")

  editor.command("vterm-run-command", async ({ editor }) => {
    const command = await editor.prompt("Run in vterm: ")
    if (!command) return
    const shell = process.env.SHELL ?? "bash"
    await spawnTerminalBuffer({ argv: [shell, "-lc", command], name: `*vterm*<${command}>`, mode: "vterm" })
  }, "Run a shell command in a vterm buffer.")

  editor.command("opencode", async ({ editor }) => {
    await spawnTerminalBuffer({ argv: ["opencode"], name: "*opencode*", mode: "vterm" })
  }, "Run opencode in a vterm buffer.")

  editor.command("vterm-opencode", async ({ editor }) => {
    await editor.run("opencode")
  }, "Run opencode in a vterm buffer.")

  editor.command("vterm-char-mode", ({ buffer, editor }) => {
    if (!sessions.has(buffer)) return editor.message("No term session")
    buffer.readOnly = true
    buffer.locals.set(TERM_SURFACE_ENABLED_LOCAL, true)
    const s = sessions.get(buffer)
    if (s) updateTerminalSurface(buffer, s)
    editor.overridingTerminalLocalMap = termRawMap
    void editor.changed("vterm-char-mode")
  }, "Switch the current vterm buffer to terminal character mode.")

  editor.command("term-char-mode", async ({ editor }) => {
    await editor.run("vterm-char-mode")
  })

  editor.command("vterm-copy-mode", ({ buffer, editor }) => {
    buffer.readOnly = false
    buffer.locals.set(TERM_SURFACE_ENABLED_LOCAL, false)
    buffer.locals.delete(TERMINAL_SURFACE_LOCAL)
    editor.overridingTerminalLocalMap = null
    void editor.changed("vterm-copy-mode")
  }, "Switch the current vterm buffer to copy/edit mode.")

  editor.command("term-line-mode", async ({ editor }) => {
    await editor.run("vterm-copy-mode")
  })

  // Universal escape: a stuck term override soft-locks the whole editor, so
  // keyboard-quit must always be able to tear it down (t-f2e861cb).
  ctx.advice("keyboard-quit", {
    after: ({ editor }) => {
      if (editor.overridingTerminalLocalMap === termRawMap) editor.overridingTerminalLocalMap = null
    },
  })

  editor.command("vterm-send-raw", ({ buffer, editor, args, keyEvent }) => {
    // ctx.keyEvent is captured at dispatch; editor.lastKeyEvent can already be
    // the *next* key under rapid input (t-414394c1). Fallback covers M-x.
    const k = keyEvent ?? editor.lastKeyEvent
    const s = sessions.get(buffer)
    if (!s) return editor.message("No term session")
    const bytes = args[0] ?? (k ? keyToPtyBytes(k) : null)
    if (bytes != null) writeRaw(s, bytes)
  })

  editor.command("term-send-raw", async ({ editor, keyEvent, args }) => {
    await editor.run("vterm-send-raw", args, keyEvent)
  })

  editor.command("vterm-send-string", async ({ buffer, editor }) => {
    const s = sessions.get(buffer)
    if (!s) return editor.message("No term session")
    const str = await editor.prompt("Send: ")
    if (str != null) writeRaw(s, str + "\r")
  })

  editor.command("term-send-string", async ({ editor }) => {
    await editor.run("vterm-send-string")
  })

  editor.command("vterm-send-C-c", ({ buffer }) => {
    const s = sessions.get(buffer)
    if (s) writeRaw(s, "\x03")
  })
  editor.command("term-interrupt", async ({ editor }) => {
    await editor.run("vterm-send-C-c")
  })
  editor.command("vterm-kill", ({ buffer }) => sessions.get(buffer)?.pty.kill())
  editor.command("term-kill", async ({ editor }) => {
    await editor.run("vterm-kill")
  })

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
  editor.defineKey("vterm-map", "C-c C-c", "vterm-send-C-c")
  editor.defineKey("vterm-map", "C-c C-k", "vterm-kill")
  editor.defineKey("vterm-map", "C-c C-s", "vterm-send-string")
  editor.defineKey("vterm-map", "C-c C-t", "vterm-char-mode")
}
