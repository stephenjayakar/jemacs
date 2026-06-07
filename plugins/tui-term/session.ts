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
  onData(fn: (data: string) => void): { dispose(): void }
  write(data: string, cb?: () => void): void
  resize(cols: number, rows: number): void
  dispose(): void
}
type XBuffer = {
  type: "normal" | "alternate"
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
    // Full-screen TUIs like opencode require a controlling TTY. Bun.spawn with
    // openpty fds does not provide one on macOS; pty.fork() does.
    ptyModule = typeof Bun !== "undefined" && process.platform !== "darwin"
      ? await import("../term/pty")
      : await import("../term/pty-node")
  }
  return ptyModule
}

/** Per-buffer session. Owns the PTY, the headless xterm, the surface
 *  renderer, the write-coalescer, and the kill/resize lifecycle. */
export class JTermSession {
  readonly pty: Pty
  readonly xt: XTermInstance
  readonly renderer: SurfaceRenderer
  rows: number
  cols: number
  alive = true
  exitCode: number | null = null
  /** True between jterm-char-mode and jterm-copy-mode. Controls whether
   *  the buffer is read-only and whether the raw keymap is the override. */
  charMode = false

  private txBuf = ""
  private txScheduled = false
  private pendingChunks: string[] = []
  private feedScheduled = false
  private lastRenderedText = ""
  private disposed = false
  private readonly disposables: Array<{ dispose(): void }> = []

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
    // xterm emits terminal replies here (DSR cursor-position reports,
    // capability answers, etc.). Full-screen TUIs like opencode wait for these
    // before drawing anything useful, so pass them back to the child pty.
    this.disposables.push(this.xt.onData(data => {
      this.writeRaw(data)
    }))
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
    for (const d of this.disposables.splice(0)) d.dispose()
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
    this.replyToTerminalQueries(chunk)
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

  /** Some OpenTUI apps (including opencode) block their first real frame on
   *  terminal capability/color/size probes. xterm/headless handles DSR/DA and
   *  DECRQM, but does not answer OSC color queries or CSI 14t pixel-size
   *  reports. Provide the minimal replies these TUIs expect. */
  private replyToTerminalQueries(chunk: string): void {
    let reply = ""
    if (chunk.includes("\x1b]10;?\x07")) reply += "\x1b]10;rgb:d4d4/d4d4/d4d4\x07"
    if (chunk.includes("\x1b]11;?\x07")) reply += "\x1b]11;rgb:1e1e/1e1e/1e1e\x07"
    const osc4 = /\x1b\]4;(\d+);\?\x07/g
    for (let match = osc4.exec(chunk); match; match = osc4.exec(chunk)) {
      const index = Number(match[1])
      const color = index === 0 ? "0000/0000/0000" : "d4d4/d4d4/d4d4"
      reply += `\x1b]4;${index};rgb:${color}\x07`
    }
    if (chunk.includes("\x1b[14t")) {
      const pixelHeight = Math.max(1, this.rows) * 16
      const pixelWidth = Math.max(1, this.cols) * 8
      reply += `\x1b[4;${pixelHeight};${pixelWidth}t`
    }
    if (chunk.includes("a=q") && chunk.includes("Gi=31337")) {
      reply += "\x1b_Gi=31337;ENOENT:kitty graphics unavailable\x1b\\"
    }
    if (reply) this.writeRaw(reply)
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
    const mirror = this.xt.buffer.active.length > 0
      ? buildMirror(this.xt)
      : { text: "", point: 0 }
    const text = mirror.text
    let textChanged = false
    if (text.startsWith(this.lastRenderedText)) {
      const tail = text.slice(this.lastRenderedText.length)
      if (tail) {
        this.buffer.append(tail)
        textChanged = true
      }
    } else if (text !== this.buffer.text) {
      this.buffer.setText(text, false)
      textChanged = true
    }
    this.lastRenderedText = text
    this.buffer.point = mirror.point

    // 2. Cell-grid surface: only use it for alternate-screen TUIs. Normal
    // shell output (prompts, `ls`, command history) is better represented by
    // the text mirror because some shells repaint the full viewport with blank
    // lines, which can hide command output from the active grid while it still
    // exists in scrollback. Full-screen TUIs (opencode, vim, htop) switch to
    // the alternate buffer, where the grid is the source of truth.
    if (this.xt.buffer.active.type === "alternate") {
      const surface = buildSurface(this.xt as unknown as Parameters<typeof buildSurface>[0])
      this.renderer.updateSurface(surface)
    } else {
      this.renderer.invalidate()
      if (textChanged) void this.editor.changed(`${this.label}-output`)
    }
  }
}

/** Walk the headless xterm buffer (viewport + scrollback) into a single text
 *  mirror. zsh/starship-style prompts repaint the viewport by writing many
 *  blank rows before drawing the prompt; if kept verbatim, ordinary command
 *  output (`ls`) is pushed above the visible window. Drop only the contiguous
 *  blank repaint run immediately before the cursor row. */
function buildMirror(xt: XTermInstance): { text: string; point: number } {
  const buf = xt.buffer.active
  const lines: string[] = []
  let lastNonEmpty = -1
  const cursorRow = buf.baseY + buf.cursorY
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)
    const s = lineTextForMirror(buf, line, y, cursorRow)
    lines.push(s)
    if (s.length > 0) lastNonEmpty = y
  }
  const keep = Math.max(lastNonEmpty, buf.baseY + buf.cursorY, 0) + 1
  lines.length = keep

  let adjustedCursorRow = Math.min(cursorRow, lines.length - 1)
  let blank = adjustedCursorRow - 1
  while (blank >= 0 && lines[blank] === "") blank--
  const blanksToDrop = adjustedCursorRow - blank - 1
  if (blanksToDrop > 0) {
    lines.splice(blank + 1, blanksToDrop)
    adjustedCursorRow -= blanksToDrop
  }

  let point = 0
  for (let y = 0; y < adjustedCursorRow; y++) point += (lines[y]?.length ?? 0) + 1
  const cursorLine = buf.getLine(cursorRow)
  if (!cursorLine) return { text: lines.join("\n"), point }
  let cx = 0
  const scratch = buf.getNullCell()
  for (let x = 0; x < buf.cursorX; x++) {
    if (!cursorLine.getCell(x, scratch)) break
    if (scratch.getWidth() === 0) continue
    cx += scratch.getChars().length || 1
  }
  return { text: lines.join("\n"), point: point + cx }
}

function lineTextForMirror(buf: XBuffer, line: XBufferLine | undefined, y: number, cursorRow: number): string {
  if (!line) return ""
  if (y !== cursorRow) return line.translateToString(true).trimEnd()
  const raw = line.translateToString(false)
  const visible = line.translateToString(true).trimEnd()
  return raw.slice(0, Math.max(buf.cursorX, visible.length))
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
): Promise<JTermSession> {
  const cwd = opts.cwd ?? editor.currentBuffer.directory?.() ?? process.cwd()
  const { spawnPty } = await loadPtyModule()
  const pty = spawnPty(argv, {
    cwd,
    rows: opts.rows,
    cols: opts.cols,
    env: { ...process.env, TERM: "xterm-256color", ...opts.env },
  })
  const xt = makeXTerm(opts.rows, opts.cols)
  const session = new JTermSession(editor, buffer, pty, xt, opts.rows, opts.cols, opts.label)
  session.wireHandlers()
  session.prime()
  return session
}
