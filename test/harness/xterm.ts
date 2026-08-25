import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { spawnPty, type Pty } from "../../plugins/term/pty"
import { markerEnv } from "./tui-reap"

const ROOT = resolve(import.meta.dir, "../..")
const MAIN = resolve(ROOT, "src/main.ts")

export type Cell = {
  char: string
  fg: number
  bg: number
  bold: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
}

/** Layer-3 probe backed by an in-process VT parser instead of tmux.
 *  `cell()` is the reason this exists — tests can assert on rendered colour
 *  and attributes, which `tuiProbe`'s plain-text capture can't. */
export type XtermProbe = {
  /** Send key tokens (tmux syntax: `C-x` `M->` `Enter` `BSpace` `Up` …) or
   *  literal text. Resolves once the pty has had a chance to echo + render. */
  type(...keys: string[]): Promise<void>
  /** Current viewport as newline-joined, right-trimmed rows. */
  screen(): string
  /** Rendered cell at (row, col), 0-indexed within the viewport. */
  cell(row: number, col: number): Cell | undefined
  /** Poll `screen()` until `re` matches; rejects with the screen on timeout. */
  waitFor(re: RegExp | string, timeoutMs?: number): Promise<void>
  cursor(): { row: number; col: number }
  rows: number
  cols: number
  close(): Promise<void>
}

/** Spawn jemacs in a pty and parse its output through `@xterm/headless`.
 *  Falls back to a tmux-backed probe (same shape, `cell()` throws) when the
 *  package is not yet installed — the term-v2 track owns adding the dep. */
export async function xtermProbe(opts?: {
  file?: string
  rows?: number
  cols?: number
  env?: Record<string, string>
}): Promise<XtermProbe> {
  const rows = opts?.rows ?? 35
  const cols = opts?.cols ?? 120

  let Terminal: (new (o: { rows: number; cols: number; allowProposedApi: boolean }) => HeadlessTerminal) | undefined
  try {
    ;({ Terminal } = await import("@xterm/headless"))
  } catch {
    return tmuxFallback(opts?.file, rows, cols)
  }

  const term = new Terminal({ rows, cols, allowProposedApi: true })
  const argv = [process.execPath, "run", MAIN, ...(opts?.file ? [opts.file] : [])]
  const pty = spawnPty(argv, { cwd: ROOT, rows, cols, env: opts?.env })

  // term.write parses asynchronously; track outstanding chunks so screen()
  // observes a fully-parsed state after `await type()` / `await waitFor()`.
  let pending = 0
  let drained: () => void = () => {}
  const settle = (): Promise<void> =>
    pending === 0 ? Promise.resolve() : new Promise(r => { drained = r })
  pty.onData(chunk => {
    pending++
    term.write(chunk, () => { if (--pending === 0) drained() })
  })

  let exited = false
  pty.onExit(() => { exited = true })

  const buf = () => term.buffer.active
  const screenText = (): string => {
    const b = buf()
    const out: string[] = []
    for (let y = 0; y < rows; y++) {
      out.push(b.getLine(b.baseY + y)?.translateToString(true) ?? "")
    }
    return out.join("\n")
  }

  const probe: XtermProbe = {
    rows, cols,
    async type(...keys) {
      for (const k of keys) {
        pty.write(keyToBytes(k))
        await sleep(20)
      }
      await sleep(60)
      await settle()
    },
    screen: screenText,
    cell(row, col) {
      const c = buf().getLine(buf().baseY + row)?.getCell(col)
      if (!c) return undefined
      return {
        char: c.getChars() || " ",
        fg: c.getFgColor(),
        bg: c.getBgColor(),
        bold: c.isBold() !== 0,
        italic: c.isItalic() !== 0,
        underline: c.isUnderline() !== 0,
        inverse: c.isInverse() !== 0,
      }
    },
    async waitFor(re, timeoutMs = 5000) {
      const rx = typeof re === "string" ? new RegExp(re) : re
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await settle()
        if (rx.test(screenText())) return
        if (exited) break
        await sleep(40)
      }
      throw new Error(`waitFor ${rx} timed out after ${timeoutMs}ms\n--- screen ---\n${screenText()}`)
    },
    cursor() {
      const b = buf()
      return { row: b.cursorY, col: b.cursorX }
    },
    async close() {
      pty.kill()
      term.dispose()
      // Give the read pump a tick to observe EOF and close the master fd.
      await sleep(20)
    },
  }

  // Same readiness gate tui-drive.sh uses.
  await probe.waitFor(/Jemacs OpenTUI/, 8000)
  return probe
}

/** Encode an Emacs/tmux-style key token as the bytes a real xterm would send.
 *  Multi-char tokens that don't parse as a key are typed literally. */
export function keyToBytes(token: string): string {
  const named: Record<string, string> = {
    Enter: "\r", RET: "\r", Return: "\r",
    Space: " ", SPC: " ",
    Tab: "\t", TAB: "\t",
    BSpace: "\x7f", DEL: "\x7f", Backspace: "\x7f",
    Escape: "\x1b", ESC: "\x1b",
    Up: "\x1b[A", Down: "\x1b[B", Right: "\x1b[C", Left: "\x1b[D",
    Home: "\x1b[H", End: "\x1b[F",
    PgUp: "\x1b[5~", PgDn: "\x1b[6~",
    Insert: "\x1b[2~", Delete: "\x1b[3~",
    F1: "\x1bOP", F2: "\x1bOQ", F3: "\x1bOR", F4: "\x1bOS",
    F5: "\x1b[15~", F6: "\x1b[17~", F7: "\x1b[18~", F8: "\x1b[19~",
    F9: "\x1b[20~", F10: "\x1b[21~", F11: "\x1b[23~", F12: "\x1b[24~",
  }
  if (named[token]) return named[token]

  const m = /^((?:C-|M-|S-)+)(.+)$/.exec(token)
  if (!m) return token  // literal text
  const mods = m[1]
  let key = named[m[2]] ?? m[2]

  if (mods.includes("C-")) {
    if (key === " " || /^(Space|SPC)$/.test(m[2])) key = "\x00"
    else if (key.length === 1) {
      const c = key.toUpperCase().charCodeAt(0)
      // C-@..C-_ covers letters, [, \, ], ^, _; C-? → DEL
      if (c >= 0x40 && c <= 0x5f) key = String.fromCharCode(c & 0x1f)
      else if (key === "?") key = "\x7f"
      else if (key === "/") key = "\x1f"
    }
  }
  if (mods.includes("M-")) key = "\x1b" + key
  return key
}

/* ------------------------------------------------------------------ */
/* Fallback: same XtermProbe shape over tmux (until @xterm/headless lands). */

let tmuxCounter = 0
const DRIVE = resolve(ROOT, "scripts/tui-drive.sh")

function tmuxFallback(file: string | undefined, rows: number, cols: number): XtermProbe {
  const session = `jx${process.pid}-${tmuxCounter++}`
  const sh = (args: string[]): string => {
    const r = spawnSync(DRIVE, args, { env: markerEnv(session), encoding: "utf8" })
    if (r.status !== 0 && args[0] !== "stop") {
      throw new Error(`tui-drive ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`)
    }
    return r.stdout
  }
  sh(["start", ...(file ? [file] : [])])
  // The pane is a grandchild of the tmux server, so close() alone is not enough
  // if the runner dies first. See "Process hygiene" in ../../AGENTS.md.
  process.on("exit", () => { sh(["stop"]) })
  return {
    rows, cols,
    async type(...keys) { sh(["keys", ...keys]) },
    screen: () => sh(["cap"]).replace(/\n+$/, ""),
    cell() { throw new Error("cell() requires @xterm/headless; tmux fallback is plain-text only") },
    async waitFor(re, timeoutMs = 5000) {
      const src = typeof re === "string" ? re : re.source
      sh(["wait", src, String(Math.ceil(timeoutMs / 1000))])
    },
    cursor() { throw new Error("cursor() requires @xterm/headless") },
    async close() { sh(["stop"]) },
  }
}

/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Minimal structural type for `@xterm/headless`'s Terminal — enough for the
 *  probe, and lets this file typecheck before the package is installed. */
type HeadlessTerminal = {
  write(data: string, cb?: () => void): void
  dispose(): void
  buffer: { active: {
    baseY: number
    cursorX: number
    cursorY: number
    getLine(y: number): {
      translateToString(trimRight?: boolean): string
      getCell(x: number): {
        getChars(): string
        getFgColor(): number
        getBgColor(): number
        isBold(): number
        isItalic(): number
        isUnderline(): number
        isInverse(): number
      } | undefined
    } | undefined
  } }
}
