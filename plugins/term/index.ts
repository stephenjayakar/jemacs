import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import { defineMode } from "../../src/modes/mode"
import { Keymap, normalizeSequence, type KeyEventLike } from "../../src/kernel/keymap"
import { addAdvice } from "../../src/runtime/advice"
import { spawnPty, type Pty } from "./pty"

export type TermState = { pty: Pty; lines: string[]; row: number; col: number }
export const sessions = new WeakMap<BufferModel, TermState>()

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

/** v1 render: maintain a line array; CR rewinds column, LF advances row. Strip CSI/OSC. */
export function feed(state: TermState, buffer: BufferModel, chunk: string): void {
  const clean = chunk
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")   // OSC
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")               // CSI
    .replace(/\x1b[=><]/g, "")                             // keypad mode
  for (const ch of clean) {
    if (ch === "\r") { state.col = 0; continue }
    if (ch === "\n") { state.row++; state.lines[state.row] ??= ""; continue }
    if (ch === "\b") { state.col = Math.max(0, state.col - 1); continue }
    if (ch === "\x07" || ch < " ") continue
    const line = state.lines[state.row] ?? ""
    state.lines[state.row] = line.slice(0, state.col) + ch + line.slice(state.col + 1)
    state.col++
  }
  // Streamed output is the common case: append the delta past the shared
  // prefix so we don't push a full-buffer undo snapshot per pty chunk.
  const next = state.lines.join("\n")
  const old = buffer.text
  let i = 0
  const max = Math.min(old.length, next.length)
  while (i < max && old[i] === next[i]) i++
  if (i === old.length) buffer.append(next.slice(i))
  else buffer.setText(next, false, false)
  buffer.point = buffer.text.length
}

export function install(editor: Editor): void {
  defineMode({ name: "term", parent: "text", keymap: new Keymap("term-map") })

  editor.command("term", async ({ editor }) => {
    const shell = process.env.SHELL ?? "bash"
    const cwd = editor.currentBuffer.directory?.() ?? process.cwd()
    const buffer = editor.scratch(`*term*<${shell}>`, "")
    buffer.mode = "term"
    const pty = spawnPty([shell, "-i"], { cwd, rows: 30, cols: 100 })
    const state: TermState = { pty, lines: [""], row: 0, col: 0 }
    sessions.set(buffer, state)
    pty.onData(chunk => { feed(state, buffer, chunk); void editor.changed("term-output") })
    pty.onExit(code => {
      buffer.append(`\n[process exited ${code}]\n`)
      sessions.delete(buffer)
      // The override is editor-global; drop it whenever *this* term installed it,
      // even if the user has since clicked into another window (t-f2e861cb).
      if (editor.overridingTerminalLocalMap === termRawMap) editor.overridingTerminalLocalMap = null
      if (editor.currentBuffer === buffer) void editor.run("term-line-mode")
      void editor.changed("term-exit")
    })
    await editor.run("term-char-mode")
    editor.message(`term: ${shell} (pid ${pty.pid})`)
  }, "Spawn an interactive shell in a *term* buffer (v1: raw output, no VT parser).")

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
  addAdvice("keyboard-quit", {
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
    if (bytes == null) return
    s.pty.write(bytes)
  })

  editor.command("term-send-string", async ({ buffer, editor }) => {
    const s = sessions.get(buffer)
    if (!s) return editor.message("No term session")
    const str = await editor.prompt("Send: ")
    if (str != null) s.pty.write(str + "\r")
  })

  editor.command("term-interrupt", ({ buffer }) => sessions.get(buffer)?.pty.write("\x03"))
  editor.command("term-kill", ({ buffer }) => sessions.get(buffer)?.pty.kill())

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
