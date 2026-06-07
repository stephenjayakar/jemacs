import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import { defineMode, getMode } from "../../src/modes/mode"
import { Keymap, type KeyEventLike } from "../../src/kernel/keymap"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { TERMINAL_SURFACE_LOCAL } from "../../src/display/terminal-surface"
import { JTermSession, spawnSession } from "./session"
import { jtermRawMap } from "./keymap-adapter"
import { keyToPtyBytes } from "./key-encode"

export { keyToPtyBytes } from "./key-encode"
export { JTermSession, spawnSession, makeXTerm } from "./session"
export type { XTermInstance } from "./session"
export { JTermRawMap, jtermRawMap } from "./keymap-adapter"
export { surfaceChanged } from "./renderer"

const PASTE_HANDLER_LOCAL = "paste-handler"
const JTERM_SESSION_LOCAL = "jterm-session"
const JTERM_MODE = "jterm-mode"
const JTERM_MODE_MAP = "jterm-mode-map"

/** Per-buffer WeakMap of session → editor. Kept independent of term-v2's
 *  `sessions` map so both plugins can coexist. */
export const sessions = new WeakMap<BufferModel, JTermSession>()

/** Find the session attached to `buffer`, if any. */
export function sessionFor(buffer: BufferModel): JTermSession | undefined {
  return sessions.get(buffer)
}

defcustom("jterm-scrollback", "number", 10_000, "Lines of scrollback the headless xterm keeps.")
defcustom("jterm-bracketed-paste", "boolean", true, "Wrap paste payloads in ESC[200~…ESC[201~ so the child can opt in.")
defcustom("jterm-bell-handler", "string", "message", "How to surface a BEL from the child: 'message', 'ignore', or a custom command name.")

/** Resolve the window body's row/col from buffer.locals. Defaults to 30x100
 *  for first-paint when the buffer hasn't been displayed yet. */
function bodyDims(buffer: BufferModel): { rows: number; cols: number } {
  const rows = (buffer.locals.get("window-body-rows") as number | undefined) ?? 30
  const cols = (buffer.locals.get("window-body-cols") as number | undefined) ?? 100
  return { rows: Math.max(1, rows), cols: Math.max(1, cols) }
}

async function spawnTerminalBuffer(editor: Editor, opts: {
  argv: string[]
  name: string
  cwd?: string
  env?: Record<string, string>
}): Promise<BufferModel> {
  const buffer = editor.scratch(opts.name, "", JTERM_MODE)
  const { rows, cols } = bodyDims(buffer)
  const session = await spawnSession(editor, buffer, opts.argv, {
    cwd: opts.cwd,
    env: opts.env,
    rows,
    cols,
    label: "jterm",
  })
  sessions.set(buffer, session)
  buffer.locals.set(JTERM_SESSION_LOCAL, true)
  // Resize the PTY to the actual pane geometry. The window-configuration-change
  // hook that would normally do this fires once during the editor.scratch()
  // microtask, BEFORE sessions.set() runs, so the first hook fire is a no-op
  // and syncWindowBodyGeometry's "no change" early-return blocks later fires.
  // Doing the resize here (right after registration) covers that case.
  const liveRows = buffer.locals.get("window-body-rows") as number | undefined
  const liveCols = buffer.locals.get("window-body-cols") as number | undefined
  if (liveRows && liveCols) session.resize(liveRows, liveCols)
  await editor.run("jterm-char-mode")
  editor.message(`jterm: ${opts.argv.join(" ")} (pid ${session.pty.pid})`)
  return buffer
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  // Idempotent re-install: keep an already-registered keymap so a second
  // install() (tests, plugin reload) preserves any extra bindings.
  const jtermMap = getMode(JTERM_MODE)?.keymap ?? new Keymap(JTERM_MODE_MAP)
  defineMode({
    name: JTERM_MODE,
    parent: "text",
    keymap: jtermMap,
  })

  // Char-mode: every printable key goes raw; C-c is the prefix. The exact
  // set mirrors term-v2's term-map so muscle memory transfers.
  const lower = "abcdefghijklmnopqrstuvwxyz".split("")
  const punct = `!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`.split("")
  for (const k of [...lower, ...lower.map(c => `S-${c}`), ..."0123456789", ...punct,
                   "space", "enter", "backspace", "tab", "up", "down", "left", "right",
                   "home", "end", "pageup", "pagedown", "insert", "delete"]) {
    editor.defineKey(JTERM_MODE_MAP, k, "jterm-send-raw")
  }
  editor.defineKey(JTERM_MODE_MAP, "C-c C-c", "jterm-interrupt")
  editor.defineKey(JTERM_MODE_MAP, "C-c C-k", "jterm-kill")
  editor.defineKey(JTERM_MODE_MAP, "C-c C-s", "jterm-send-string")
  editor.defineKey(JTERM_MODE_MAP, "C-c C-j", "jterm-copy-mode")
  editor.defineKey(JTERM_MODE_MAP, "C-c C-w", "jterm-copy-mode")
  editor.defineKey(JTERM_MODE_MAP, "C-c C-t", "jterm-char-mode")
  editor.defineKey(JTERM_MODE_MAP, "C-c C-y", "jterm-yank")
  editor.defineKey(JTERM_MODE_MAP, "C-c C-l", "jterm-clear")
  editor.defineKey(JTERM_MODE_MAP, "C-c C-r", "jterm-reset")

  // Top-level entry points. We bind the most common ones to the global map
  // so users can M-x jterm or just hit the key.
  editor.key("C-c t", "jterm")  // GNU-style C-c t
  editor.key("C-c T", "vterm")     // C-c T still launches the vterm plugin

  editor.command("jterm", async ({ editor }) => {
    const shell = process.env.SHELL ?? "bash"
    await spawnTerminalBuffer(editor, { argv: [shell, "-i"], name: `*jterm*<${shell}>` })
  }, "Spawn an interactive shell in a *jterm* buffer (low-latency PTY mode).")

  editor.command("jterm-run-command", async ({ editor }) => {
    const command = await editor.prompt("Run in jterm: ")
    if (!command) return
    const shell = process.env.SHELL ?? "bash"
    await spawnTerminalBuffer(editor, { argv: [shell, "-lc", command], name: `*jterm*<${command}>` })
  }, "Run a one-shot shell command in a jterm buffer.")

  editor.command("opencode", async ({ editor }) => {
    await spawnTerminalBuffer(editor, { argv: ["opencode"], name: "*opencode*" })
  }, "Run opencode in a jterm buffer (replaces the vterm binding for the same name).")

  // ---- char-mode / copy-mode ----

  editor.command("jterm-char-mode", ({ buffer, editor }) => {
    const session = sessions.get(buffer)
    if (!session) return editor.message("No jterm session in this buffer")
    session.charMode = true
    buffer.readOnly = true
    // Install the per-buffer paste handler so terminal paste goes to the pty
    // (run-core.ts:38 consults buffer.locals["paste-handler"] before insert).
    buffer.locals.set(PASTE_HANDLER_LOCAL, (text: string) => {
      const bracketed = getCustom<boolean>("jterm-bracketed-paste") !== false
      const wrapped = bracketed ? `\x1b[200~${text}\x1b[201~` : text
      session.writeRaw(wrapped)
    })
    editor.overridingTerminalLocalMap = jtermRawMap
    void editor.changed("jterm-char-mode")
  }, "Switch the current jterm buffer to terminal character mode.")

  editor.command("jterm-copy-mode", ({ buffer, editor }) => {
    const session = sessions.get(buffer)
    if (!session) return editor.message("No jterm session in this buffer")
    session.charMode = false
    buffer.readOnly = false
    buffer.locals.delete(PASTE_HANDLER_LOCAL)
    if (editor.overridingTerminalLocalMap === jtermRawMap) editor.overridingTerminalLocalMap = null
    // Hide the cell-grid surface so the pane renders the text mirror in copy-mode
    // (matches term-v2's behavior; users can scroll / select / yank).
    buffer.locals.delete(TERMINAL_SURFACE_LOCAL)
    void editor.changed("jterm-copy-mode")
  }, "Switch the current jterm buffer to copy/edit mode (scrollback is editable).")

  // Universal escape: a stuck char-mode override soft-locks the whole editor,
  // so keyboard-quit must always be able to tear it down.
  ctx.advice("keyboard-quit", {
    after: ({ editor }) => {
      if (editor.overridingTerminalLocalMap === jtermRawMap) editor.overridingTerminalLocalMap = null
      // Also drop the read-only flag so a follow-up C-g from copy-mode works.
      const buf = editor.activeBuffer
      if (buf?.locals.has(PASTE_HANDLER_LOCAL)) {
        // user is mid-paste-route in char-mode: fall back to copy-mode
        void editor.run("jterm-copy-mode")
      }
    },
  })

  // ---- send keys / strings ----

  editor.command("jterm-send-raw", ({ buffer, editor, args, keyEvent }) => {
    const session = sessions.get(buffer)
    if (!session) return editor.message("No jterm session in this buffer")
    const k = (keyEvent ?? editor.lastKeyEvent) as KeyEventLike | null
    const bytes = args[0] ?? (k ? keyToPtyBytes(k) : null)
    if (bytes != null) session.writeRaw(bytes)
  }, "Send the current key (or ARG) as raw bytes to the jterm pty.")

  editor.command("jterm-send-string", async ({ buffer, editor }) => {
    const session = sessions.get(buffer)
    if (!session) return editor.message("No jterm session in this buffer")
    const str = await editor.prompt("Send: ")
    if (str != null) session.writeRaw(str + "\r")
  }, "Prompt for a string to send to the jterm pty (CR-terminated).")

  editor.command("jterm-yank", ({ buffer, editor }) => {
    const session = sessions.get(buffer)
    if (!session) return editor.message("No jterm session in this buffer")
    // The Emacs kill-ring lives on the editor; default the yank to the most
    // recent text kill, mirroring emacs -nw's yank behavior.
    const lastText = editor.locals.get("last-yank")
    if (typeof lastText === "string" && lastText.length > 0) {
      session.writeRaw(`\x1b[200~${lastText}\x1b[201~`)
    } else {
      editor.message("Yank: ring is empty")
    }
  }, "Paste the most recent Emacs kill into the jterm pty (bracketed).")

  editor.command("jterm-interrupt", ({ buffer }) => {
    sessions.get(buffer)?.writeRaw("\x03")
  }, "Send SIGINT (Ctrl-C) to the jterm pty.")

  editor.command("jterm-kill", ({ buffer, editor }) => {
    const session = sessions.get(buffer)
    if (!session) return editor.message("No jterm session in this buffer")
    session.kill()
    editor.message(`jterm: killed (pid ${session.pty.pid})`)
  }, "Kill the jterm pty and dispose the session.")

  editor.command("jterm-clear", ({ buffer }) => {
    sessions.get(buffer)?.writeRaw("\x1b[2J\x1b[H")
  }, "Send the standard clear-screen escape to the jterm pty.")

  editor.command("jterm-reset", ({ buffer }) => {
    sessions.get(buffer)?.writeRaw("\x1bc")
  }, "Send a full terminal reset (ESC c) to the jterm pty.")

  // ---- window lifecycle ----

  // Keep the pty's winsize in sync with the displaying window. The display
  // layer stashes the leaf's body geometry on the buffer before firing the
  // hook (Emacs convention: window-configuration-change-hook is buffer-local).
  ctx.hook("window-configuration-change-hook", ({ buffer }) => {
    const session = sessions.get(buffer)
    if (!session) return
    const rows = buffer.locals.get("window-body-rows") as number | undefined
    const cols = buffer.locals.get("window-body-cols") as number | undefined
    if (rows && cols) session.resize(rows, cols)
  })

  // Auto-cleanup when a jterm buffer is killed (C-x k, bury-buffer, etc.).
  // kill-buffer-hook is buffer-local; this runs only when `buffer` is the
  // buffer being killed.
  ctx.hook("kill-buffer-hook", ({ buffer }) => {
    const session = sessions.get(buffer)
    if (!session) return
    session.dispose()
    sessions.delete(buffer)
    if (editor.overridingTerminalLocalMap === jtermRawMap) editor.overridingTerminalLocalMap = null
  })

  // Editor-wide cleanup: C-x C-c (quit) used to leak PTY processes because
  // disposeAllContexts only tears down plugin contexts, not their PTYs. This
  // kills any jterm session still alive at editor exit time.
  ctx.hook("kill-emacs-hook", () => {
    for (const buf of editor.buffers.values()) {
      const session = sessions.get(buf)
      if (session && session.alive) session.kill()
    }
  })
}
