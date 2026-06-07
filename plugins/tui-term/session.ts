import { createRequire } from "node:module"
import type { BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import type { Pty } from "../term/pty"
import type { KeyEventLike } from "../../src/kernel/keymap"
import { TERMINAL_SURFACE_LOCAL } from "../../src/display/terminal-surface"
import { SurfaceRenderer } from "./renderer"
import { buildSurface } from "./surface"
import { keyToPtyBytes } from "./key-encode"

const require = createRequire(import.meta.url)

type TerminalCtor = new (options: { rows: number; cols: number; allowProposedApi?: boolean; scrollback?: number }) => XTermInstance
type XTermInstance = {
  rows: number
  cols: number
  buffer: { active: XBuffer }
  write(data: string, cb?: () => void): void
  resize(cols: number, rows: number): void
  dispose(): void
}
type XBuffer = {
  baseY: number
  cursorY: number
  cursorX: number
  length: number
  getLine(y: number): XBufferLine | undefined
  getNullCell(): XBufferCell
}
type XBufferLine = { translateToString(trim?: boolean): string; getCell(x: number, cell: XBufferCell): boolean }
type XBufferCell = {
  getWidth(): number
  getChars(): string
  isBold(): boolean
  isItalic(): boolean
  isUnderline(): boolean
  isFgDefault(): boolean
  isBgDefault(): boolean
  isFgRGB(): boolean
  isBgRGB(): boolean
  isFgPalette(): boolean
  isBgPalette(): boolean
  getFgColor(): number
  getBgColor(): number
}

function resolveTerminalCtor(): TerminalCtor {
  const mod = require("@xterm/headless") as { Terminal?: TerminalCtor; default?: TerminalCtor }
  const ctor = mod.Terminal ?? mod.default
  if (!ctor) throw new Error("@xterm/headless: no Terminal export")
  return ctor
}

function makeXTerm(rows: number, cols: number): XTermInstance {
  return new (resolveTerminalCtor())({
    rows,
    cols,
    allowProposedApi: true,
    scrollback: 10_000,
  })
}
export { makeXTerm }

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

/** Per-buffer session. Owns the PTY, the headless xterm, the surface
 *  renderer, the write-coalescer, and the kill/resize lifecycle. */
export class TuiTermSession {
  readonly pty: Pty
  readonly xt: XTermInstance
  readonly renderer: SurfaceRenderer
  rows: number
  cols: number
  alive = true
  exitCode: number | null = null
  /** True between tui-term-char-mode and tui-term-copy-mode. Controls whether
   *  the buffer is read-only and whether the raw keymap is the override. */
  charMode = false

  private txBuf = ""
  private txScheduled = false
  private pendingChunks: string[] = []
  private feedScheduled = false
  private lastRenderedText = ""
  private disposed = false

  constructor(
    private readonly editor: Editor,
    readonly buffer: BufferModel,
    pty: Pty,
    xt: XTermInstance,
    rows: number,
    cols: number,
    private readonly label: string,
  ) {
    this.pty = pty
    this.xt = xt
    this.rows = rows
    this.cols = cols
    this.renderer = new SurfaceRenderer(editor, buffer, label)
  }

  /** Wire the PTY data + exit handlers. Call once at session construction. */
  wireHandlers(): void {
    this.pty.onData(chunk => {
      this.feedChunk(chunk)
    })
    this.pty.onExit(code => {
      this.alive = false
      this.exitCode = code
      this.mirrorFromXterm()
      this.buffer.append(`\n[process exited ${code ?? "?"}]\n`)
      this.editor.changed(`${this.label}-exit`)
    })
  }

  /** Queue bytes for the pty and flush them as a single write on the next
   *  microtask. Concurrent fs.write() calls to the same fd are not ordered,
   *  so a same-tick burst of one-byte writes (host keypress without await)
   *  can land reordered at the shell. Microtask coalescing fixes that. */
  writeRaw(bytes: string): void {
    if (!this.alive) return
    this.txBuf += bytes
    if (this.txScheduled) return
    this.txScheduled = true
    queueMicrotask(() => {
      this.txScheduled = false
      const buf = this.txBuf
      this.txBuf = ""
      if (buf) this.pty.write(buf)
    })
  }

  /** Encode a key event to pty bytes and queue them. */
  sendKey(k: KeyEventLike | null | undefined): void {
    if (!k) return
    this.writeRaw(keyToPtyBytes(k))
  }

  /** Resize both the pty (TIOCSWINSZ ⇒ SIGWINCH) and the headless xterm grid,
   *  then re-mirror. No-ops on unchanged dims. */
  resize(rows: number, cols: number): void {
    if (rows < 1 || cols < 1) return
    if (this.rows === rows && this.cols === cols) return
    this.rows = rows
    this.cols = cols
    if (this.alive) this.pty.resize(rows, cols)
    this.xt.resize(cols, rows)
    this.renderer.invalidate()
    this.mirrorFromXterm()
  }

  /** Kill the underlying pty. Idempotent. */
  kill(): void {
    if (!this.alive) return
    this.alive = false
    this.pty.kill()
  }

  /** Tear down the session. The host PTY is killed and timers cleared. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.kill()
    this.renderer.dispose()
    try { this.xt.dispose() } catch { /* xterm.dispose() throws on bad state */ }
    this.buffer.locals.delete(TERMINAL_SURFACE_LOCAL)
    this.buffer.locals.delete("paste-handler")
  }

  /** Initial mirror so the pane shows something before the first chunk lands. */
  prime(): void {
    this.mirrorFromXterm()
  }

  /** Coalesce a burst of PTY chunks into a single xterm.write, then mirror
   *  the parsed result back into the buffer. xterm.write is async (it sets
   *  a setTimeout internally) — we don't await it; the onParsed callback
   *  fires on a later microtask. */
  private feedChunk(chunk: string): void {
    this.pendingChunks.push(chunk)
    if (this.feedScheduled) return
    this.feedScheduled = true
    queueMicrotask(() => {
      this.feedScheduled = false
      const chunks = this.pendingChunks
      this.pendingChunks = []
      const data = chunks.join("")
      this.xt.write(data, () => {
        this.mirrorFromXterm()
      })
    })
  }

  /** Test seam: feed a VT byte string directly without going through the pty.
   *  Returns a promise that resolves after the xterm parse + mirror settle. */
  feed(chunk: string, done?: () => void): Promise<void> {
    return new Promise(resolve => {
      this.xt.write(chunk, () => {
        this.mirrorFromXterm()
        done?.()
        resolve()
      })
    })
  }

  /** Diff the xterm buffer against the buffer text and the cached surface,
   *  updating both atomically. Called from xterm write completion + on resize. */
  mirrorFromXterm(): void {
    if (this.disposed) return
    // 1. Text mirror: streaming-append on the fast path, full replace when VT
    //    codes rewrote earlier cells (cursor positioning, erase-line, etc.).
    const text = this.xt.buffer.active.length > 0
      ? buildTextMirror(this.xt)
      : ""
    if (text.startsWith(this.lastRenderedText)) {
      const tail = text.slice(this.lastRenderedText.length)
      if (tail) this.buffer.append(tail)
    } else if (text !== this.buffer.text) {
      this.buffer.setText(text, false)
    }
    this.lastRenderedText = text
    this.buffer.point = computeCursorTextPoint(this.xt)

    // 2. Cell-grid surface: diff against last, only emit changed() if different.
    const surface = buildSurface(this.xt as unknown as Parameters<typeof buildSurface>[0])
    this.renderer.updateSurface(surface)
  }
}

/** Walk the headless xterm buffer (viewport + scrollback) into a single
 *  string with \n between rows, trimmed of trailing empty rows past the
 *  cursor. This is the text-mirror that the buffer's `text` field shows. */
function buildTextMirror(xt: XTermInstance): string {
  const buf = xt.buffer.active
  const lines: string[] = []
  let lastNonEmpty = -1
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)
    const s = line?.translateToString(true) ?? ""
    lines.push(s)
    if (s.length > 0) lastNonEmpty = y
  }
  const keep = Math.max(lastNonEmpty, buf.baseY + buf.cursorY, 0) + 1
  lines.length = keep
  return lines.join("\n")
}

/** Convert xterm cursor (row, col) to a buffer text offset. */
function computeCursorTextPoint(xt: XTermInstance): number {
  const buf = xt.buffer.active
  const cursorRow = buf.baseY + buf.cursorY
  let point = 0
  for (let y = 0; y < cursorRow; y++) {
    const line = buf.getLine(y)
    point += (line?.translateToString(true).length ?? 0) + 1
  }
  const cursorLine = buf.getLine(cursorRow)
  if (!cursorLine) return point
  let cx = 0
  const scratch = buf.getNullCell()
  for (let x = 0; x < buf.cursorX; x++) {
    if (!cursorLine.getCell(x, scratch)) break
    if (scratch.getWidth() === 0) continue
    cx += scratch.getChars().length || 1
  }
  return point + cx
}

export type { XTermInstance }

/** Spawn a session against a fresh headless xterm. */
export async function spawnSession(
  editor: Editor,
  buffer: BufferModel,
  argv: string[],
  opts: {
    cwd?: string
    env?: Record<string, string>
    rows: number
    cols: number
    label: string
  },
): Promise<TuiTermSession> {
  const cwd = opts.cwd ?? editor.currentBuffer.directory?.() ?? process.cwd()
  const { spawnPty } = await loadPtyModule()
  const pty = spawnPty(argv, {
    cwd,
    rows: opts.rows,
    cols: opts.cols,
    env: { ...process.env, TERM: "xterm-256color", ...opts.env },
  })
  const xt = makeXTerm(opts.rows, opts.cols)
  const session = new TuiTermSession(editor, buffer, pty, xt, opts.rows, opts.cols, opts.label)
  session.wireHandlers()
  session.prime()
  return session
}
