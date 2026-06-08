import type { CommandContext } from "../src/kernel/command"
import type { Editor } from "../src/kernel/editor"
import type { PluginContext } from "../src/runtime/plugin-context"
import type { BufferModel } from "../src/kernel/buffer"
import type { TextSpan } from "../src/modes/mode"
import { defvar } from "../src/runtime/custom"
import { isPrintable } from "../src/kernel/keymap"
import { scrollDownCommand, scrollUpCommand, selectedWindowBodyBudget } from "../src/display/scroll"
import { pythonBeginningOfDefun, pythonEndOfDefun } from "../src/modes/python"
import { spawnProcess } from "../src/platform/runtime"
import { readKey } from "./misc"

const KILL_COMMANDS = new Set(["kill-line", "kill-word", "backward-kill-word", "kill-region"])

export function install(editor: Editor, ctx?: PluginContext): void {
  editor.command("forward-char", ({ buffer, prefixArgument }) => buffer.move(prefixArgument ?? 1), "Move point forward one character.")
  editor.command("backward-char", ({ buffer, prefixArgument }) => buffer.move(-(prefixArgument ?? 1)), "Move point backward one character.")
  editor.command("next-line", ({ buffer, prefixArgument }) => buffer.moveLine(prefixArgument ?? 1), "Move point down one line.")
  editor.command("previous-line", ({ buffer, prefixArgument }) => buffer.moveLine(-(prefixArgument ?? 1)), "Move point up one line.")
  editor.command("move-beginning-of-line", ({ buffer, prefixArgument }) => {
    const arg = prefixArgument ?? 1
    if (arg !== 1) buffer.moveLine(arg - 1)
    buffer.moveToLineStart()
  }, "Move point to the beginning of the line.")
  editor.command("move-end-of-line", ({ buffer, prefixArgument }) => {
    const arg = prefixArgument ?? 1
    if (arg !== 1) buffer.moveLine(arg - 1)
    buffer.moveToLineEnd()
  }, "Move point to the end of the line.")

  editor.command("forward-word", ({ buffer, prefixArgument }) => {
    const n = prefixArgument ?? 1
    const dir = n < 0 ? -1 : 1
    for (let i = 0; i < Math.abs(n); i++) moveByWord(buffer, dir)
  }, "Move point forward one word.")
  editor.command("backward-word", ({ buffer, prefixArgument }) => {
    const n = prefixArgument ?? 1
    const dir = n < 0 ? 1 : -1
    for (let i = 0; i < Math.abs(n); i++) moveByWord(buffer, dir)
  }, "Move point backward one word.")

  editor.command("beginning-of-buffer", ({ buffer, prefixArgument }) => {
    if (prefixArgument == null && !buffer.markActive) {
      buffer.mark = buffer.point
      buffer.markActive = false
    }
    if (prefixArgument != null) {
      buffer.point = forwardLineFrom(buffer.text, tenthFractionPosition(buffer.text, prefixArgument, false))
    } else {
      buffer.moveToBufferStart()
    }
  }, "Set mark (without activating) and move point to the beginning of the buffer.")
  editor.command("end-of-buffer", ({ buffer, editor, prefixArgument }) => {
    if (prefixArgument == null && !buffer.markActive) {
      buffer.mark = buffer.point
      buffer.markActive = false
    }
    if (prefixArgument != null) {
      buffer.point = forwardLineFrom(buffer.text, tenthFractionPosition(buffer.text, prefixArgument, true))
    } else {
      buffer.moveToBufferEnd()
      recenterEndOfBuffer(editor)
    }
  }, "Set mark (without activating) and move point to the end of the buffer.")

  editor.command("goto-line", async ({ buffer, editor, args }) => {
    const value = args[0] ?? await editor.prompt("Goto line: ", "", "goto-line")
    const line = Math.max(1, Number(value) || 1)
    const lines = buffer.text.split("\n")
    const offset = lines.slice(0, line - 1).reduce((offset, text) => offset + text.length + 1, 0)
    buffer.point = Math.min(offset, buffer.text.length)
  }, "Move point to a line number.")

  editor.command("scroll-up-command", ({ editor, prefixArgument }) => scrollUpCommand(editor, prefixArgument), "Scroll forward one screenful.")
  editor.command("scroll-down-command", ({ editor, prefixArgument }) => scrollDownCommand(editor, prefixArgument), "Scroll backward one screenful.")

  // Shadowed by plugins/mark-ring in production; retained so a core-only
  // editor (new Editor() with no builtins) still has C-space bound.
  editor.command("set-mark-command", ({ buffer, editor }) => {
    buffer.setMark()
    editor.message("Mark set")
  }, "Set mark at point.")

  editor.command("exchange-point-and-mark", ({ buffer, editor, prefixArgument }) => {
    if (!buffer.exchangePointAndMark(prefixArgument == null)) {
      editor.message("No mark set in this buffer")
      return
    }
  }, "Exchange point and mark, activating the region.")

  editor.command("clear-mark", ({ buffer, editor }) => {
    buffer.clearMark()
    editor.message("Mark cleared")
  }, "Clear mark.")

  editor.command("mark-whole-buffer", ({ buffer }) => {
    buffer.point = buffer.text.length
    buffer.setMark()
    buffer.point = 0
    buffer.markActive = true
  }, "Set mark at end and point at beginning of buffer.")

  const beginningOfDefun = ({ buffer, editor }: CommandContext) => {
    if (buffer.mode === "python") {
      pythonBeginningOfDefun(buffer)
      return
    }
    editor.message("No defun navigation for this mode")
  }
  const endOfDefun = ({ buffer, editor }: CommandContext) => {
    if (buffer.mode === "python") {
      pythonEndOfDefun(buffer)
      return
    }
    editor.message("No defun navigation for this mode")
  }
  editor.command("beginning-of-defun", beginningOfDefun, "Move to the beginning of the current defun.")
  editor.command("end-of-defun", endOfDefun, "Move to the end of the current defun.")
  editor.command("python-beginning-of-defun", beginningOfDefun, "Compatibility alias for beginning-of-defun in Python buffers.")
  editor.command("python-end-of-defun", endOfDefun, "Compatibility alias for end-of-defun in Python buffers.")

  // ---- kill ring / basic editing -----------------------------------------

  // defvar holds the per-editor map so the ring outlives a hot-reload of this
  // module; WeakMap keying keeps separate Editor instances (tests) isolated.
  // The yank cursor and last-yank span are transient and reset to head on reload.
  const rings = defvar("kill-ring", new WeakMap<Editor, string[]>(), "Per-editor kill ring storage.").value
  let killRing = rings.get(editor)
  if (!killRing) rings.set(editor, killRing = [])
  let yankRingIndex = 0
  let lastYankStart: number | null = null
  let lastYankEnd: number | null = null
  let lastCommandName: string | null = null

  const offChanged = editor.events.on("changed", ({ reason }) => {
    if (reason.startsWith("command:")) lastCommandName = reason.slice("command:".length)
  })
  ctx?.onDispose(offChanged)
  const lastCommandWasKill = () => lastCommandName != null && KILL_COMMANDS.has(lastCommandName)

  const pushKill = (text: string, append = false, before = false) => {
    if (!text) return
    if (append && killRing.length) {
      killRing[0] = before ? text + killRing[0]! : killRing[0]! + text
      yankRingIndex = 0
      return
    }
    killRing.unshift(text)
    if (killRing.length > 60) killRing.length = 60
    yankRingIndex = 0
  }

  const recordYank = (buffer: BufferModel, text: string) => {
    lastYankStart = buffer.point - text.length
    lastYankEnd = buffer.point
    yankRingIndex = 0
  }

  const yankPop = (buffer: BufferModel) => {
    if (!killRing.length) return
    yankRingIndex = (yankRingIndex + 1) % killRing.length
    const text = killRing[yankRingIndex]!
    if (lastYankStart != null && lastYankEnd != null) {
      buffer.replaceRange(lastYankStart, lastYankEnd, text)
      lastYankEnd = lastYankStart + text.length
    } else {
      buffer.insert(text)
      lastYankStart = buffer.point - text.length
      lastYankEnd = buffer.point
    }
  }

  const killWords = (buffer: CommandContext["buffer"], n: number) => {
    const start = buffer.point
    const dir = n < 0 ? -1 : 1
    for (let i = 0; i < Math.abs(n); i++) moveByWord(buffer, dir)
    pushKill(buffer.deleteRange(start, buffer.point), lastCommandWasKill(), dir < 0)
  }

  editor.command("self-insert-command", async ({ buffer, editor, args, prefixArgument }) => {
    const key = editor.lastKeyEvent
    const ch = args[0] ?? key?.sequence
    if (!ch) return
    const text = ch.repeat(Math.max(1, Math.abs(prefixArgument ?? 1)))
    if (editor.quotedInsertNext) {
      editor.quotedInsertNext = false
      if (editor.minibuffer) await editor.minibufferInsert(text)
      else buffer.insert(text)
      return
    }
    if (!args[0] && (!key || !isPrintable(key))) return
    if (editor.minibuffer) await editor.minibufferInsert(text)
    else buffer.insert(text)
  }, "Insert the character you type.")

  editor.command("newline", ({ buffer }) => buffer.insert("\n"), "Insert a newline at point.")

  editor.command("open-line", ({ buffer }) => {
    buffer.insert("\n")
    buffer.move(-1)
  }, "Insert a newline after point without moving point.")

  editor.command("transpose-chars", ({ buffer }) => {
    if (buffer.point >= buffer.text.length) buffer.move(-1)
    if (buffer.point < 1) return
    const i = buffer.point
    const text = buffer.text
    buffer.replaceRange(i - 1, i + 1, text[i]! + text[i - 1]!)
  }, "Transpose the character before point with the character at point.")

  editor.command("quoted-insert", ({ editor }) => {
    editor.quotedInsertNext = true
    editor.message("Quoted insert — type a character")
  }, "Read the next input event and insert it literally.")

  editor.command("delete-char", ({ buffer, prefixArgument }) => {
    if (buffer.deleteActiveRegion()) return
    repeat(prefixArgument, () => buffer.deleteForward(), () => buffer.deleteBackward())
  }, "Delete the character after point (or the active region).")

  editor.command("delete-backward-char", async ({ buffer, editor, prefixArgument }) => {
    if (editor.minibuffer) {
      // minibufferBackspace refreshes completions; deleteActiveRegion would skip that.
      const n = prefixArgument ?? 1
      const count = Math.max(1, Math.abs(n))
      for (let i = 0; i < count; i++) {
        if (n < 0) buffer.deleteForward()
        else await editor.minibufferBackspace()
      }
      return
    }
    if (buffer.deleteActiveRegion()) return
    repeat(prefixArgument, () => buffer.deleteBackward(), () => buffer.deleteForward())
  }, "Delete the character before point (or the active region).")

  editor.command("newline-and-indent", ({ editor, buffer }) => {
    buffer.insert("\n")
    editor.indentLine(buffer)
  }, "Insert a newline, then indent according to the current major mode.")

  editor.command("indent-for-tab-command", async ({ editor, buffer }) => {
    if (!await editor.completeAtPoint(buffer)) editor.indentLine(buffer)
  }, "Complete the symbol at point, or indent the current line.")

  editor.command("undo", ({ buffer }) => buffer.undo(), "Undo the last text edit.")
  editor.command("undo-redo", ({ buffer }) => buffer.redo(), "Redo the last undone text edit.")
  editor.command("redo", ({ buffer }) => buffer.redo(), "Compatibility alias for undo-redo.")

  editor.command("kill-line", ({ buffer, prefixArgument }) => {
    const append = lastCommandWasKill()
    const start = buffer.point
    let end: number
    if (prefixArgument != null) {
      end = nthLineBoundary(buffer.text, start, prefixArgument)
    } else {
      const nl = buffer.text.indexOf("\n", start)
      const tail = nl === -1 ? buffer.text.slice(start) : buffer.text.slice(start, nl)
      // Emacs rule: if the rest of the line is blank, kill through the newline.
      end = nl === -1 ? buffer.text.length : (/^\s*$/.test(tail) ? nl + 1 : nl)
    }
    pushKill(buffer.deleteRange(start, end), append, end < start)
  }, "Kill text from point to end of line.")

  editor.command("kill-word", ({ buffer, prefixArgument }) => killWords(buffer, prefixArgument ?? 1), "Kill the word after point.")
  editor.command("backward-kill-word", ({ buffer, prefixArgument }) => killWords(buffer, -(prefixArgument ?? 1)), "Kill the word before point.")

  editor.command("kill-region", ({ buffer }) => {
    if (buffer.mark == null || buffer.mark === buffer.point) {
      const line = buffer.lineBoundsAt()
      const end = line.end < buffer.text.length ? line.end + 1 : line.end
      pushKill(buffer.deleteRange(line.start, end))
      return
    }
    pushKill(buffer.deleteRange(buffer.mark, buffer.point))
    buffer.clearMark()
  }, "Kill the active region, or the current line when no region is active.")

  editor.command("kill-ring-save", ({ buffer, editor }) => {
    const selected = buffer.selectedText() || buffer.lineBoundsAt().text + (buffer.lineBoundsAt().end < buffer.text.length ? "\n" : "")
    pushKill(selected)
    editor.message(buffer.selectedText() ? "Copied region" : "Copied line")
  }, "Copy the active region, or the current line when no region is active.")

  editor.command("yank", ({ buffer }) => {
    const text = killRing[yankRingIndex]
    if (!text) return
    buffer.insert(text)
    recordYank(buffer, text)
  }, "Insert the last killed text at point.")

  editor.command("yank-pop", ({ buffer, editor }) => {
    yankPop(buffer)
    editor.message("Yank pop")
  }, "Replace the last yank with the next item on the kill ring.")

  editor.command("kill-rectangle", ({ buffer, editor }) => {
    if (buffer.mark == null) {
      editor.message("Mark must be set for rectangle command")
      return
    }
    const killed = killRectangle(buffer)
    pushKill(killed)
    editor.message("Killed rectangle")
  }, "Kill the text in the rectangle defined by point and mark.")

  editor.command("yank-rectangle", ({ buffer, editor }) => {
    const text = killRing[yankRingIndex]
    if (!text) return
    yankRectangle(buffer, text)
    editor.message("Yanked rectangle")
  }, "Insert the last killed rectangle.")

  editor.command("copy-region-to-clipboard-mac", async ({ buffer, editor }) => {
    const text = buffer.selectedText() || buffer.lineBoundsAt().text
    const pbcopy = spawnProcess({ cmd: ["pbcopy"], stdin: "pipe" })
    pbcopy.stdin?.write(text)
    pbcopy.stdin?.end()
    await pbcopy.exited
    pushKill(text)
    editor.message("Copied text to clipboard")
  }, "Copy region or current line to the macOS clipboard.")

  editor.command("replace-string", async ({ buffer, editor, args }) => {
    const from = args[0] ?? await editor.prompt("Replace string: ", "", "replace")
    if (!from) return
    const to = args[1] ?? await editor.prompt(`Replace ${from} with: `, "", "replace")
    if (to == null) return
    const region = buffer.mark == null || buffer.mark === buffer.point ? { start: 0, end: buffer.text.length } : { start: Math.min(buffer.mark, buffer.point), end: Math.max(buffer.mark, buffer.point) }
    const replaced = buffer.text.slice(region.start, region.end).split(from).join(to)
    buffer.replaceRange(region.start, region.end, replaced)
  }, "Replace a string in the region or current buffer.")

  // Kernel has no removeOverlaySource yet, so register the source once per
  // Editor (defvar/WeakMap, like kill-ring) and have each install reuse the
  // same state object — reloads then mutate it instead of stacking closures.
  type QrState = { buffer: BufferModel | null; spans: TextSpan[] }
  const qrStates = defvar("query-replace--overlay-state", new WeakMap<Editor, QrState>(),
    "Per-editor query-replace overlay state; guards one-time addOverlaySource registration.").value
  let qr = qrStates.get(editor)
  if (!qr) {
    qrStates.set(editor, qr = { buffer: null, spans: [] })
    editor.addOverlaySource(b => (b === qr!.buffer ? qr!.spans : []))
  }
  ctx?.onDispose(() => { qr!.buffer = null; qr!.spans = [] })
  editor.command("query-replace", async ({ buffer, editor, args }) => {
    const from = args[0] ?? await editor.prompt("Query replace: ", "", "query-replace")
    if (!from) return
    const to = args[1] ?? await editor.prompt(`Replace ${from} with: `, "", "query-replace")
    if (to == null) return
    let index = buffer.point
    let count = 0
    let all = false
    qr!.buffer = buffer
    const trail: Array<{ at: number; replaced: boolean }> = []
    try {
    while (index <= buffer.text.length) {
      const at = buffer.text.indexOf(from, index)
      if (at === -1) break
      buffer.point = at
      qr!.spans = [{ start: at, end: at + from.length, face: "isearch" }]
      const key = all ? "y" : await readKey(editor, `Query replacing ${from} with ${to}: (y n q ! . ^) `)
      if (key === null || key === "q" || key === "enter" || key === "esc") break
      if (key === "y" || key === "space" || key === "!" || key === ".") {
        buffer.replaceRange(at, at + from.length, to)
        trail.push({ at, replaced: true })
        index = at + to.length
        count++
        if (key === "!") all = true
        if (key === ".") break
      } else if (key === "n" || key === "backspace") {
        trail.push({ at, replaced: false })
        index = at + from.length
      } else if (key === "^") {
        const prev = trail.pop()
        if (!prev) { editor.message("No previous match"); continue }
        if (prev.replaced) { buffer.replaceRange(prev.at, prev.at + to.length, from); count-- }
        index = prev.at
      }
      // any other key: re-prompt at the same match
    }
    } finally {
      qr!.spans = []
      qr!.buffer = null
    }
    editor.message(`Replaced ${count} occurrence${count === 1 ? "" : "s"}`)
  }, "Replace occurrences with confirmation.")

  editor.key("right", "forward-char")
  editor.key("C-f", "forward-char")
  editor.key("left", "backward-char")
  editor.key("C-b", "backward-char")
  editor.key("down", "next-line")
  editor.key("C-n", "next-line")
  editor.key("up", "previous-line")
  editor.key("C-p", "previous-line")
  editor.key("C-a", "move-beginning-of-line")
  editor.key("C-e", "move-end-of-line")
  editor.key("M-f", "forward-word")
  editor.key("M-b", "backward-word")
  editor.key("M-<", "beginning-of-buffer")
  editor.key("M->", "end-of-buffer")
  editor.key("C-M-a", "beginning-of-defun")
  editor.key("C-M-e", "end-of-defun")
  for (const key of ["home", "kp-home", "C-home", "begin"]) editor.key(key, "beginning-of-buffer")
  for (const key of ["end", "kp-end", "C-end"]) editor.key(key, "end-of-buffer")
  for (const key of ["prior", "kp-prior", "pageup"]) editor.key(key, "scroll-down-command")
  for (const key of ["next", "kp-next", "pagedown"]) editor.key(key, "scroll-up-command")
  editor.key("M-g g", "goto-line")
  editor.key("C-v", "scroll-up-command")
  editor.key("M-v", "scroll-down-command")
  editor.key("C-space", "set-mark-command")
  editor.key("C-@", "set-mark-command")
  editor.key("C-x C-x", "exchange-point-and-mark")
  editor.key("C-x h", "mark-whole-buffer")

  editor.key("return", "newline")
  editor.key("enter", "newline")
  editor.key("C-m", "newline")
  editor.key("C-j", "newline-and-indent")
  editor.key("tab", "indent-for-tab-command")
  editor.key("C-i", "indent-for-tab-command")
  editor.key("C-o", "open-line")
  editor.key("C-t", "transpose-chars")
  editor.key("C-q", "quoted-insert")
  editor.key("delete", "delete-char")
  editor.key("C-d", "delete-char")
  editor.key("backspace", "delete-backward-char")
  editor.defineKey("minibuffer", "backspace", "delete-backward-char")

  editor.key("C-k", "kill-line")
  editor.key("M-d", "kill-word")
  editor.key("M-backspace", "backward-kill-word")
  editor.key("M-h", "backward-kill-word")
  editor.key("C-w", "kill-region")
  editor.key("M-w", "kill-ring-save")
  editor.key("C-y", "yank")
  editor.key("M-y", "yank-pop")
  editor.key("C-x r k", "kill-rectangle")
  editor.key("C-x r y", "yank-rectangle")

  editor.key("C-_", "undo")
  editor.key("C-/", "undo")
  editor.key("C-x u", "undo")

  editor.key("C-c r", "replace-string")
  editor.key("M-%", "query-replace")
}

/** Emacs `simple.el`: N/10 of the way from the beginning or end of the buffer. */
function tenthFractionPosition(text: string, tenth: number, fromEnd: boolean): number {
  const size = text.length
  return fromEnd
    ? Math.max(0, size - Math.floor((size * tenth) / 10))
    : Math.min(size, Math.floor((size * tenth) / 10))
}

/** Emacs `forward-line` after a fractional buffer jump — start of the next line. */
function forwardLineFrom(text: string, pos: number): number {
  if (pos >= text.length) return text.length
  const nl = text.indexOf("\n", pos)
  return nl === -1 ? text.length : nl + 1
}

/** Emacs `end-of-buffer` recenter: put point three lines above the window bottom. */
function recenterEndOfBuffer(editor: Editor): void {
  const leaf = editor.selectedWindowLeaf()
  if (!leaf) return
  const cursorLine = editor.currentBuffer.lineCol().line - 1
  const bodyBudget = selectedWindowBodyBudget(editor)
  const fromBottom = 3
  const start = Math.max(0, cursorLine - (bodyBudget - fromBottom - 1))
  editor.setSelectedWindowStartLine(start)
}

function repeat(prefixArgument: number | null, fwd: () => void, bwd?: () => void): void {
  const n = prefixArgument ?? 1
  const fn = n < 0 ? (bwd ?? fwd) : fwd
  for (let i = 0; i < Math.abs(n); i++) fn()
}

/** Offset of the start of the line `n` lines after (n>0) or before (n<=0) `from`. */
function nthLineBoundary(text: string, from: number, n: number): number {
  if (n > 0) {
    let pos = from
    for (let i = 0; i < n; i++) {
      const nl = text.indexOf("\n", pos)
      if (nl === -1) return text.length
      pos = nl + 1
    }
    return pos
  }
  let pos = text.lastIndexOf("\n", from - 1) + 1
  for (let i = 0; i < -n; i++) pos = text.lastIndexOf("\n", pos - 2) + 1
  return Math.max(0, pos)
}

function killRectangle(buffer: BufferModel): string {
  const start = Math.min(buffer.mark ?? buffer.point, buffer.point)
  const end = Math.max(buffer.mark ?? buffer.point, buffer.point)
  const startLine = buffer.text.slice(0, start).split("\n").length - 1
  const endLine = buffer.text.slice(0, end).split("\n").length - 1
  const startCol = start - (buffer.text.lastIndexOf("\n", start - 1) + 1)
  const endCol = end - (buffer.text.lastIndexOf("\n", end - 1) + 1)
  const colA = Math.min(startCol, endCol)
  const colB = Math.max(startCol, endCol)
  const lines = buffer.text.split("\n")
  const chunks: string[] = []
  for (let line = startLine; line <= endLine; line++) {
    const text = lines[line] ?? ""
    chunks.push(text.slice(colA, colB))
  }
  const killed = chunks.join("\n")
  const rebuilt = lines.map((text, line) => {
    if (line < startLine || line > endLine) return text
    return text.slice(0, colA) + text.slice(colB)
  }).join("\n")
  buffer.setText(rebuilt, true)
  buffer.point = start
  buffer.clearMark()
  return killed
}

function yankRectangle(buffer: BufferModel, rectangle: string): void {
  const lines = rectangle.split("\n")
  const { line, col } = buffer.lineCol()
  const parts = buffer.text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const idx = line - 1 + i
    if (idx < 0 || idx >= parts.length) break
    const row = parts[idx]!
    const at = Math.min(col - 1, row.length)
    parts[idx] = row.slice(0, at) + lines[i]! + row.slice(at)
  }
  buffer.setText(parts.join("\n"), true)
}

/** Unicode-aware word motion so non-ASCII letters and combining marks are
 *  word constituents (e.g. NFD `café`). Defers to `buffer.moveWord` when a
 *  mode (e.g. subword-mode) has overridden the word regexps. */
function moveByWord(buffer: CommandContext["buffer"], dir: 1 | -1): void {
  if (buffer.locals.has("word-forward-regexp") || buffer.locals.has("word-backward-regexp")) {
    buffer.moveWord(dir)
    return
  }
  if (dir > 0) {
    const m = /[\p{L}\p{M}\p{N}_]+/u.exec(buffer.text.slice(buffer.point))
    buffer.point = m ? buffer.point + m.index + m[0].length : buffer.text.length
  } else {
    const matches = [...buffer.text.slice(0, buffer.point).matchAll(/[\p{L}\p{M}\p{N}_]+/gu)]
    buffer.point = matches.at(-1)?.index ?? 0
  }
}
