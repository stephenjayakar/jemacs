import type { CommandContext } from "../src/kernel/command"
import type { Editor } from "../src/kernel/editor"
import type { PluginContext } from "../src/runtime/plugin-context"
import type { BufferModel } from "../src/kernel/buffer"
import type { TextSpan } from "../src/modes/mode"
import { defcustom, defvar, getCustom } from "../src/runtime/custom"
import { currentKill, getKillRing, killNew, killRingIndex as ringIndex } from "../src/runtime/kill-ring"
import { isPrintable } from "../src/kernel/keymap"
import { scrollDownCommand, scrollUpCommand, selectedWindowBodyBudget } from "../src/display/scroll"
import { modeFeature } from "../src/modes/mode"
import { spawnProcess } from "../src/platform/runtime"
import { readKey } from "./misc"

const KILL_COMMANDS = new Set(["kill-line", "kill-word", "backward-kill-word", "kill-region", "clipboard-kill-region"])

defcustom("read-quoted-char-radix", "number", 8,
  "Radix for numeric character input read by `quoted-insert'.", "editing")

export function install(editor: Editor, ctx?: PluginContext): void {
  const moveChar = (buffer: BufferModel, editor: Editor, delta: number) => {
    const target = buffer.point + delta
    if (target < 0) {
      buffer.point = 0
      editor.message("Beginning of buffer")
      return
    }
    if (target > buffer.text.length) {
      buffer.point = buffer.text.length
      editor.message("End of buffer")
      return
    }
    buffer.point = target
  }

  const moveLine = (buffer: BufferModel, editor: Editor, delta: number) => {
    const target = buffer.lineAt(buffer.point) + delta
    buffer.moveLine(delta)
    if (target < 0) editor.message("Beginning of buffer")
    else if (target >= buffer.lineCount) editor.message("End of buffer")
  }

  editor.command("forward-char", ({ buffer, editor, prefixArgument }) => moveChar(buffer, editor, prefixArgument ?? 1), "Move point forward one character.")
  editor.command("backward-char", ({ buffer, editor, prefixArgument }) => moveChar(buffer, editor, -(prefixArgument ?? 1)), "Move point backward one character.")
  editor.command("next-line", ({ buffer, editor, prefixArgument }) => moveLine(buffer, editor, prefixArgument ?? 1), "Move point down one line.")
  editor.command("previous-line", ({ buffer, editor, prefixArgument }) => moveLine(buffer, editor, -(prefixArgument ?? 1)), "Move point up one line.")
  editor.command("move-beginning-of-line", ({ buffer, prefixArgument }) => {
    const arg = prefixArgument ?? 1
    if (arg !== 1) buffer.moveLine(arg - 1)
    buffer.moveToLineStart()
  }, "Move point to the beginning of the line.")
  editor.command("move-end-of-line", ({ buffer, prefixArgument }) => {
    const arg = prefixArgument ?? 1
    if (buffer.lineAt(buffer.point) + arg - 1 < 0) {
      buffer.point = 0
      return
    }
    if (arg !== 1) buffer.moveLine(arg - 1)
    buffer.moveToLineEnd()
  }, "Move point to the end of the line.")

  editor.command("forward-word", ({ buffer, prefixArgument }) => {
    const n = prefixArgument ?? 1
    const dir = n < 0 ? -1 : 1
    for (let i = 0; i < Math.abs(n); i++) {
      if (!moveByWord(buffer, dir)) return false
    }
    return true
  }, "Move point forward one word.")
  editor.command("backward-word", ({ buffer, prefixArgument }) => {
    const n = prefixArgument ?? 1
    const dir = n < 0 ? 1 : -1
    for (let i = 0; i < Math.abs(n); i++) {
      if (!moveByWord(buffer, dir)) return false
    }
    return true
  }, "Move point backward one word.")

  editor.command("beginning-of-buffer", ({ buffer, prefixArgument }) => {
    if (!buffer.markActive) {
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
    if (!buffer.markActive) {
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

  editor.command("goto-line", async ({ buffer, editor, args, prefixArgument }) => {
    const value = prefixArgument ?? args[0] ?? await editor.prompt("Goto line: ", "", "goto-line")
    if (value == null || value === "") return
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

  editor.command("deactivate-mark", ({ buffer }) => {
    buffer.markActive = false
  }, "Deactivate the mark.")

  editor.command("jemacs-clear-mark", ({ buffer, editor }) => {
    buffer.clearMark()
    editor.message("Mark cleared")
  }, "Jemacs extension command that clears mark entirely.")

  editor.command("mark-whole-buffer", ({ buffer }) => {
    buffer.point = buffer.text.length
    buffer.setMark()
    buffer.point = 0
    buffer.markActive = true
  }, "Set mark at end and point at beginning of buffer.")

  const defunMotion = (back: boolean) => ({ buffer, editor, prefixArgument }: CommandContext) => {
    const n = prefixArgument ?? 1
    const move = modeFeature(buffer.mode, n < 0 === back ? "endOfDefun" : "beginningOfDefun")
    if (!move) return editor.message("No defun navigation for this mode")
    for (let i = 0; i < Math.max(1, Math.abs(n)); i++) move(buffer)
  }
  const beginningOfDefun = defunMotion(true)
  const endOfDefun = defunMotion(false)
  editor.command("beginning-of-defun", beginningOfDefun, "Move to the beginning of the current defun.")
  editor.command("end-of-defun", endOfDefun, "Move to the end of the current defun.")
  editor.command("jemacs-python-beginning-of-defun", beginningOfDefun, "Jemacs extension alias for beginning-of-defun in Python buffers.")
  editor.command("jemacs-python-end-of-defun", endOfDefun, "Jemacs extension alias for end-of-defun in Python buffers.")

  // ---- kill ring / basic editing -----------------------------------------

  // The kill ring itself lives in runtime/kill-ring so packages can use
  // Emacs-like `kill-new` behavior. Yank cursor state remains command-local.
  const killRing = getKillRing(editor)
  let yankRingIndex = 0
  let lastYankStart: number | null = null
  let lastYankEnd: number | null = null
  let lastCommandName: string | null = null

  const offChanged = editor.events.on("changed", ({ reason }) => {
    if (!reason.startsWith("command:")) return
    lastCommandName = reason.slice("command:".length)
    if (!["yank", "yank-pop", "clipboard-yank"].includes(lastCommandName)) {
      lastYankStart = null
      lastYankEnd = null
    }
  })
  ctx?.onDispose(offChanged)
  const lastCommandWasKill = () => lastCommandName != null && KILL_COMMANDS.has(lastCommandName)
  const lastCommandWasYank = () => lastCommandName === "yank" || lastCommandName === "yank-pop" || lastCommandName === "clipboard-yank"

  const pushKill = (text: string, append = false, before = false) => {
    if (!text) return
    killNew(editor, text, { append, before })
    yankRingIndex = 0
  }

  const recordYank = (buffer: BufferModel, text: string, ringIndex = 0) => {
    lastYankStart = buffer.point - text.length
    lastYankEnd = buffer.point
    buffer.mark = lastYankStart
    buffer.markActive = false
    yankRingIndex = ringIndex
  }

  const yankPop = (buffer: BufferModel, delta: number): boolean => {
    if (!killRing.length) return false
    if (!lastCommandWasYank() || lastYankStart == null || lastYankEnd == null) return false
    yankRingIndex = ringIndex(editor, yankRingIndex + delta)
    const text = currentKill(editor, yankRingIndex)!
    buffer.replaceRange(lastYankStart, lastYankEnd, text)
    lastYankEnd = lastYankStart + text.length
    buffer.mark = lastYankStart
    buffer.markActive = false
    return true
  }

  const killWords = (buffer: CommandContext["buffer"], n: number) => {
    const start = buffer.point
    const dir = n < 0 ? -1 : 1
    for (let i = 0; i < Math.abs(n); i++) moveByWord(buffer, dir)
    pushKill(buffer.deleteRange(start, buffer.point), lastCommandWasKill(), dir < 0)
  }

  // pbcopy/pbpaste are macOS-only; ENOENT is the expected non-mac path and
  // degrades silently. Anything else is a real failure and must surface.
  const isENOENT = (err: unknown) => err != null && typeof err === "object" && "code" in err && err.code === "ENOENT"

  const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
      const pbcopy = spawnProcess({ cmd: ["pbcopy"], stdin: "pipe" })
      pbcopy.stdin?.write(text)
      pbcopy.stdin?.end()
      return await pbcopy.exited === 0
    } catch (err) {
      if (isENOENT(err)) return false
      throw err
    }
  }

  const readFromClipboard = async (): Promise<string | null> => {
    try {
      const pbpaste = spawnProcess({ cmd: ["pbpaste"], stdout: "pipe" })
      const stream = pbpaste.stdout
      if (!stream) return null
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          chunks.push(value)
          length += value.length
        }
      }
      const code = await pbpaste.exited
      if (code !== 0) return null
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      return new TextDecoder().decode(bytes)
    } catch (err) {
      if (isENOENT(err)) return null
      throw err
    }
  }

  const quotedKeyText = (key: CommandContext["keyEvent"], fallback?: string): string | null => {
    if (fallback) return fallback
    if (!key) return null
    if (key.sequence) return key.sequence
    if (key.ctrl && key.name.length === 1) {
      const ch = key.name.toUpperCase()
      const code = ch.charCodeAt(0)
      if (code >= 64 && code <= 95) return String.fromCharCode(code - 64)
    }
    if (key.name === "space" && key.ctrl) return "\0"
    if (key.name === "tab") return "\t"
    if (key.name === "enter" || key.name === "return") return "\r"
    if (key.name === "linefeed") return "\n"
    if (key.name === "escape" || key.name === "esc") return "\x1b"
    if (key.name === "backspace" || key.name === "delete") return "\x7f"
    return null
  }

  const quotedDigitValue = (text: string | null, radix: number): number | null => {
    if (!text || text.length !== 1) return null
    const code = text.toLowerCase().charCodeAt(0)
    const value = code >= 48 && code <= 57
      ? code - 48
      : code >= 97 && code <= 122
        ? code - 87
        : -1
    return value >= 0 && value < radix ? value : null
  }

  const finishQuotedInsert = (editor: Editor): void => {
    editor.quotedInsertNext = false
    editor.quotedInsertCount = 1
    editor.quotedInsertCode = null
  }

  const insertQuotedText = async (editor: Editor, buffer: BufferModel, text: string): Promise<void> => {
    if (editor.minibuffer) await editor.minibufferInsert(text)
    else buffer.insert(text)
  }

  const insertQuotedCode = async (editor: Editor, buffer: BufferModel, digits: string, radix: number, count: number): Promise<boolean> => {
    const code = Number.parseInt(digits, radix)
    try {
      await insertQuotedText(editor, buffer, String.fromCodePoint(code).repeat(count))
      return true
    } catch {
      editor.message(`${code} is not a valid character`)
      return false
    }
  }

  const quotedInsertTerminator = (key: CommandContext["keyEvent"]): boolean =>
    key?.name === "enter" || key?.name === "return" || key?.name === "linefeed"

  editor.command("self-insert-command", async ({ buffer, editor, args, prefixArgument, keyEvent }) => {
    const key = editor.lastKeyEvent
    const quoted = editor.quotedInsertNext
    const ch = quoted ? quotedKeyText(keyEvent ?? key, args[0]) : args[0] ?? key?.sequence
    const count = quoted ? editor.quotedInsertCount : prefixArgument ?? 1
    if (quoted) {
      if (count <= 0) {
        finishQuotedInsert(editor)
        return
      }
      const codeState = editor.quotedInsertCode
      if (codeState) {
        const keyText = quotedKeyText(keyEvent ?? key, args[0])
        const digit = quotedDigitValue(keyText, codeState.radix)
        if (digit != null) {
          codeState.digits += keyText
          if (codeState.radix === 8 && codeState.digits.length >= 3) {
            await insertQuotedCode(editor, buffer, codeState.digits, codeState.radix, codeState.count)
            finishQuotedInsert(editor)
            editor.quotedInsertSwallowTerminator = true
          }
          return
        }
        await insertQuotedCode(editor, buffer, codeState.digits, codeState.radix, codeState.count)
        finishQuotedInsert(editor)
        if (quotedInsertTerminator(keyEvent ?? key)) return
        return { redispatchKey: keyEvent ?? key }
      }
      const radix = Math.max(2, Math.min(36, Math.trunc(getCustom<number>("read-quoted-char-radix") ?? 8)))
      if (ch != null && quotedDigitValue(ch, radix) != null) {
        editor.quotedInsertCode = { digits: ch, radix, count }
        return
      }
      finishQuotedInsert(editor)
    }
    if (!ch) return
    if (count < 0) {
      editor.message(`Negative repetition argument ${count}`)
      return
    }
    const text = ch.repeat(count)
    if (quoted) {
      await insertQuotedText(editor, buffer, text)
      return
    }
    if (!args[0] && (!key || !isPrintable(key))) return
    if (editor.minibuffer) await editor.minibufferInsert(text)
    else buffer.insert(text)
  }, "Insert the character you type.")

  editor.command("newline", ({ buffer, editor, prefixArgument }) => {
    const count = prefixArgument ?? 1
    if (count < 0) {
      editor.message("Repetition argument has to be non-negative")
      return
    }
    if (count === 0) return
    buffer.insert("\n".repeat(count))
  }, "Insert a newline at point.")

  editor.command("open-line", ({ buffer, editor, prefixArgument }) => {
    const count = prefixArgument ?? 1
    if (count < 0) {
      editor.message("Repetition argument has to be non-negative")
      return
    }
    buffer.insert("\n".repeat(count))
    buffer.move(-count)
  }, "Insert a newline after point without moving point.")

  editor.command("transpose-chars", ({ buffer, editor, prefixArgument }) => {
    const result = transposeChars(buffer, prefixArgument)
    if (result) editor.message(result)
  }, "Transpose the character before point with the character at point.")

  editor.command("quoted-insert", ({ editor, prefixArgument }) => {
    editor.quotedInsertNext = true
    editor.quotedInsertCount = prefixArgument ?? 1
    editor.message("Quoted insert — type a character")
  }, "Read the next input event and insert it literally.")

  editor.command("delete-char", ({ buffer, editor, prefixArgument }) => {
    if (buffer.deleteActiveRegion()) return
    const error = deleteChars(buffer, prefixArgument ?? 1)
    if (error) editor.message(error)
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
    const error = deleteChars(buffer, -(prefixArgument ?? 1))
    if (error) editor.message(error)
  }, "Delete the character before point (or the active region).")

  editor.command("newline-and-indent", ({ editor, buffer }) => {
    buffer.insert("\n")
    editor.indentLine(buffer)
  }, "Insert a newline, then indent according to the current major mode.")

  editor.command("indent-for-tab-command", async ({ editor, buffer }) => {
    if (!await editor.completeAtPoint(buffer)) editor.indentLine(buffer)
  }, "Complete the symbol at point, or indent the current line.")

  editor.command("undo", ({ buffer, prefixArgument }) => {
    for (let i = 0; i < (prefixArgument ?? 1); i++) buffer.undo()
  }, "Undo the last text edit.")
  editor.command("undo-redo", ({ buffer, prefixArgument }) => {
    for (let i = 0; i < (prefixArgument ?? 1); i++) buffer.redo()
  }, "Redo the last undone text edit.")
  editor.command("jemacs-redo", ({ buffer, prefixArgument }) => {
    for (let i = 0; i < (prefixArgument ?? 1); i++) buffer.redo()
  }, "Jemacs extension alias for undo-redo.")

  editor.command("kill-line", ({ buffer, editor, prefixArgument }) => {
    const append = lastCommandWasKill()
    const start = buffer.point
    let end: number
    if (prefixArgument != null) {
      end = nthLineBoundary(buffer.text, start, prefixArgument)
    } else {
      if (start === buffer.text.length) {
        editor.message("End of buffer")
        return
      }
      const nl = buffer.text.indexOf("\n", start)
      const tail = nl === -1 ? buffer.text.slice(start) : buffer.text.slice(start, nl)
      // Emacs rule: if the rest of the line is blank, kill through the newline.
      end = nl === -1 ? buffer.text.length : (/^\s*$/.test(tail) ? nl + 1 : nl)
    }
    pushKill(buffer.deleteRange(start, end), append, end < start)
  }, "Kill text from point to end of line.")

  editor.command("kill-word", ({ buffer, prefixArgument }) => killWords(buffer, prefixArgument ?? 1), "Kill the word after point.")
  editor.command("backward-kill-word", ({ buffer, prefixArgument }) => killWords(buffer, -(prefixArgument ?? 1)), "Kill the word before point.")

  editor.command("kill-region", ({ buffer, editor }) => {
    if (buffer.mark == null) {
      editor.message("The mark is not set now, so there is no region")
      return
    }
    pushKill(buffer.deleteRange(buffer.mark, buffer.point))
    buffer.clearMark()
  }, "Kill the text between point and mark.")

  editor.command("kill-ring-save", ({ buffer, editor }) => {
    if (buffer.mark == null) {
      editor.message("The mark is not set now, so there is no region")
      return
    }
    pushKill(buffer.selectedText())
    buffer.markActive = false
    editor.message("Copied region")
  }, "Copy the text between point and mark to the kill ring.")

  editor.command("clipboard-kill-ring-save", async ({ buffer, editor }) => {
    if (buffer.mark == null) {
      editor.message("The mark is not set now, so there is no region")
      return
    }
    const text = buffer.selectedText()
    pushKill(text)
    buffer.markActive = false
    const copied = await copyToClipboard(text)
    editor.message(copied ? "Copied region to clipboard" : "Copied region")
  }, "Copy the region to the kill ring and system clipboard.")

  editor.command("clipboard-kill-region", async ({ buffer, editor }) => {
    if (buffer.mark == null) {
      editor.message("The mark is not set now, so there is no region")
      return
    }
    const text = buffer.deleteRange(buffer.mark, buffer.point)
    pushKill(text)
    buffer.clearMark()
    const copied = await copyToClipboard(text)
    editor.message(copied ? "Killed region to clipboard" : "Killed region")
  }, "Kill the region and save it to the system clipboard.")

  editor.command("yank", ({ buffer, prefixArgument }) => {
    if (!killRing.length) return
    const index = ringIndex(editor, (prefixArgument ?? 1) - 1)
    const text = currentKill(editor, index)
    if (!text) return
    buffer.insert(text)
    recordYank(buffer, text, index)
  }, "Insert the last killed text at point.")

  editor.command("clipboard-yank", async ({ buffer }) => {
    const text = await readFromClipboard() || killRing[yankRingIndex]
    if (!text) return
    buffer.insert(text)
    recordYank(buffer, text)
  }, "Insert the clipboard contents, or the last stretch of killed text.")

  editor.command("yank-pop", ({ buffer, editor, prefixArgument }) => {
    if (!yankPop(buffer, prefixArgument ?? 1)) {
      editor.message("Previous command was not a yank")
      return
    }
    editor.message("Yank pop")
  }, "Replace the last yank with the next item on the kill ring.")

  editor.command("kill-rectangle", ({ buffer, editor }) => {
    if (buffer.mark == null) {
      editor.message("Mark must be set for rectangle command")
      return
    }
    const killed = extractRectangle(buffer, true)
    pushKill(killed)
    editor.message("Killed rectangle")
  }, "Kill the text in the rectangle defined by point and mark.")

  editor.command("copy-rectangle-as-kill", ({ buffer, editor }) => {
    if (buffer.mark == null) {
      editor.message("Mark must be set for rectangle command")
      return
    }
    pushKill(extractRectangle(buffer, false))
    buffer.markActive = false
    editor.message("Copied rectangle")
  }, "Copy the region-rectangle and save it as the last killed one.")

  editor.command("copy-rectangle-to-register", async ({ buffer, editor, args, prefixArgument }) => {
    const register = args[0] ?? await editor.prompt("Copy rectangle to register: ", "", "register")
    if (!register) return
    if (buffer.mark == null) {
      editor.message("Mark must be set for rectangle command")
      return
    }
    const rectangle = extractRectangle(buffer, prefixArgument != null)
    editor.registers.set(register, { kind: "rectangle", lines: rectangle.split("\n") })
    editor.message(`Copied rectangle to register ${register}`)
  }, "Copy rectangular region into register; with prefix arg, delete it.")

  editor.command("delete-rectangle", ({ buffer, editor }) => {
    if (buffer.mark == null) {
      editor.message("Mark must be set for rectangle command")
      return
    }
    replaceRectangle(buffer, "delete")
    editor.message("Deleted rectangle")
  }, "Delete text in the region-rectangle.")

  editor.command("clear-rectangle", ({ buffer, editor }) => {
    if (buffer.mark == null) {
      editor.message("Mark must be set for rectangle command")
      return
    }
    replaceRectangle(buffer, "clear")
    editor.message("Cleared rectangle")
  }, "Blank out the region-rectangle.")

  editor.command("open-rectangle", ({ buffer, editor }) => {
    if (buffer.mark == null) {
      editor.message("Mark must be set for rectangle command")
      return
    }
    replaceRectangle(buffer, "open")
    editor.message("Opened rectangle")
  }, "Blank out the region-rectangle, shifting text right.")

  editor.command("string-rectangle", async ({ buffer, editor, args }) => {
    if (buffer.mark == null) {
      editor.message("Mark must be set for rectangle command")
      return
    }
    const string = args[0] ?? await editor.prompt("String rectangle: ", "", "rectangle")
    if (string == null) return
    replaceRectangle(buffer, "string", string)
    editor.message("Replaced rectangle")
  }, "Replace rectangle contents with STRING on each line.")

  editor.command("string-insert-rectangle", async ({ buffer, editor, args }) => {
    if (buffer.mark == null) {
      editor.message("Mark must be set for rectangle command")
      return
    }
    const string = args[0] ?? await editor.prompt("String insert rectangle: ", "", "rectangle")
    if (string == null) return
    replaceRectangle(buffer, "insert", string)
    editor.message("Inserted string rectangle")
  }, "Insert STRING on each line of the region-rectangle.")

  editor.command("rectangle-number-lines", async ({ buffer, editor, args, prefixArgument }) => {
    if (buffer.mark == null) {
      editor.message("Mark must be set for rectangle command")
      return
    }
    const startInput = args[0] ?? (prefixArgument != null ? await editor.prompt("Number to count from: ", "1", "rectangle-number") : "1")
    if (startInput == null) return
    const startAt = Number(startInput)
    if (!Number.isFinite(startAt)) {
      editor.message(`Invalid number: ${startInput}`)
      return
    }
    const rect = rectangleBounds(buffer)
    const defaultFormat = defaultRectangleLineNumberFormat(rect, startAt)
    const format = args[1] ?? (prefixArgument != null ? await editor.prompt("Format string: ", defaultFormat, "rectangle-number") : defaultFormat)
    if (format == null) return
    numberRectangle(buffer, Number.isFinite(startAt) ? startAt : 1, format)
    editor.message("Numbered rectangle")
  }, "Insert numbers in front of the region-rectangle.")

  editor.command("yank-rectangle", ({ buffer, editor }) => {
    const text = killRing[yankRingIndex]
    if (!text) return
    yankRectangle(buffer, text)
    editor.message("Yanked rectangle")
  }, "Insert the last killed rectangle.")

  editor.command("jemacs-copy-region-to-clipboard-mac", async ({ buffer, editor }) => {
    const text = buffer.selectedText() || buffer.lineBoundsAt().text
    const copied = await copyToClipboard(text)
    pushKill(text)
    editor.message(copied ? "Copied text to clipboard" : "Copied text")
  }, "Jemacs extension command that copies region or current line to the macOS clipboard.")

  editor.command("downcase-region", ({ buffer, editor }) => {
    if (buffer.mark == null) {
      editor.message("No mark set in this buffer")
      return
    }
    replaceRegionText(buffer, text => text.toLowerCase())
  }, "Convert the region to lower case.")

  editor.command("replace-string", async ({ buffer, editor, args }) => {
    const from = args[0] ?? await editor.prompt("Replace string: ", "", "replace")
    if (!from) return
    const to = args[1] ?? await editor.prompt(`Replace ${from} with: `, "", "replace")
    if (to == null) return
    const region = buffer.markActive && buffer.mark != null && buffer.mark !== buffer.point
      ? { start: Math.min(buffer.mark, buffer.point), end: Math.max(buffer.mark, buffer.point) }
      : { start: buffer.point, end: buffer.text.length }
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
  for (const key of ["home", "kp-home", "begin"]) editor.key(key, "move-beginning-of-line")
  for (const key of ["end", "kp-end"]) editor.key(key, "move-end-of-line")
  editor.key("C-home", "beginning-of-buffer")
  editor.key("C-end", "end-of-buffer")
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
  editor.key("C-w", "kill-region")
  editor.key("M-w", "kill-ring-save")
  editor.key("C-y", "yank")
  editor.key("M-y", "yank-pop")
  editor.key("C-x r k", "kill-rectangle")
  editor.key("C-x r M-w", "copy-rectangle-as-kill")
  editor.key("C-x r r", "copy-rectangle-to-register")
  editor.key("C-x r d", "delete-rectangle")
  editor.key("C-x r c", "clear-rectangle")
  editor.key("C-x r o", "open-rectangle")
  editor.key("C-x r t", "string-rectangle")
  editor.key("C-x r N", "rectangle-number-lines")
  editor.key("C-x r y", "yank-rectangle")

  editor.key("C-_", "undo")
  editor.key("C-/", "undo")
  editor.key("C-x u", "undo")
  editor.key("C-x C-l", "downcase-region")

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

function deleteChars(buffer: BufferModel, count: number): string | null {
  if (count === 0) return null
  if (count > 0) {
    if (buffer.point + count > buffer.text.length) return "End of buffer"
    buffer.deleteRange(buffer.point, buffer.point + count)
    return null
  }
  if (buffer.point + count < 0) return "Beginning of buffer"
  buffer.deleteRange(buffer.point + count, buffer.point)
  return null
}

function transposeChars(buffer: BufferModel, prefixArgument: number | null): string | null {
  if (prefixArgument === 0) return "No mark set in this buffer"
  if (buffer.point < 1) return "Beginning of buffer"
  const text = buffer.text
  if (prefixArgument == null) {
    const point = buffer.point >= text.length ? buffer.point - 1 : buffer.point
    if (point < 1) return "Beginning of buffer"
    const pair = text.slice(point - 1, point + 1)
    if (pair.length < 2) return "End of buffer"
    buffer.replaceRange(point - 1, point + 1, pair[1]! + pair[0]!)
    return null
  }

  const from = buffer.point - 1
  const to = from + prefixArgument
  if (to < 0) return "Beginning of buffer"
  if (to >= text.length) return "End of buffer"
  const ch = text[from]!
  const without = text.slice(0, from) + text.slice(from + 1)
  const replaced = without.slice(0, to) + ch + without.slice(to)
  buffer.setText(replaced, true)
  buffer.point = to + 1
  return null
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

function extractRectangle(buffer: BufferModel, deleteFlag: boolean): string {
  const rect = rectangleBounds(buffer)
  const chunks = rect.lines.slice(rect.startLine, rect.endLine + 1)
    .map(text => text.slice(rect.colA, rect.colB))
  const killed = chunks.join("\n")
  if (!deleteFlag) return killed
  replaceRectangle(buffer, "delete")
  return killed
}

type RectangleEditMode = "delete" | "clear" | "open" | "string" | "insert"

function replaceRectangle(buffer: BufferModel, mode: RectangleEditMode, replacement = ""): void {
  const start = Math.min(buffer.mark ?? buffer.point, buffer.point)
  const rect = rectangleBounds(buffer)
  const width = Math.max(0, rect.colB - rect.colA)
  const rebuilt = rect.lines.map((text, line) => {
    if (line < rect.startLine || line > rect.endLine) return text
    const before = text.slice(0, rect.colA)
    const after = text.slice(mode === "open" || mode === "insert" ? rect.colA : rect.colB)
    if (mode === "delete") return before + after
    if (mode === "clear") return before + " ".repeat(width) + after
    if (mode === "open") return before + " ".repeat(width) + after
    return before + replacement + after
  }).join("\n")
  buffer.setText(rebuilt, true)
  buffer.point = start
  buffer.clearMark()
}

function replaceRegionText(buffer: BufferModel, transform: (text: string) => string): void {
  if (buffer.mark == null) return
  const point = buffer.point
  const mark = buffer.mark
  const markActive = buffer.markActive
  const start = Math.min(mark, point)
  const end = Math.max(mark, point)
  const replacement = transform(buffer.text.slice(start, end))
  buffer.replaceRange(start, end, replacement)
  buffer.point = Math.min(point, buffer.text.length)
  buffer.mark = Math.min(mark, buffer.text.length)
  buffer.markActive = markActive
}

function numberRectangle(buffer: BufferModel, startAt: number, format: string): void {
  const start = Math.min(buffer.mark ?? buffer.point, buffer.point)
  const rect = rectangleBounds(buffer)
  const rebuilt = rect.lines.map((text, line) => {
    if (line < rect.startLine || line > rect.endLine) return text
    const value = formatNumber(format, startAt + line - rect.startLine)
    const padded = text.length < rect.colA ? text + " ".repeat(rect.colA - text.length) : text
    return padded.slice(0, rect.colA) + value + padded.slice(rect.colA)
  }).join("\n")
  buffer.setText(rebuilt, true)
  buffer.point = start
  buffer.clearMark()
}

function defaultRectangleLineNumberFormat(rect: { startLine: number; endLine: number }, startAt: number): string {
  const last = Math.trunc(startAt) + (rect.endLine - rect.startLine)
  return `%${String(last).length}d `
}

function formatNumber(format: string, value: number): string {
  return format
    .replace(/%%/g, "\0")
    .replace(/%([0 ]?)(\d*)d/g, (_match, flag: string, widthText: string) => {
      const text = String(value)
      const width = Number(widthText || 0)
      if (text.length >= width) return text
      const padding = (flag === "0" ? "0" : " ").repeat(width - text.length)
      return padding + text
    })
    .replace(/\0/g, "%")
}

function rectangleBounds(buffer: BufferModel): { startLine: number; endLine: number; colA: number; colB: number; lines: string[] } {
  const start = Math.min(buffer.mark ?? buffer.point, buffer.point)
  const end = Math.max(buffer.mark ?? buffer.point, buffer.point)
  const startLine = buffer.text.slice(0, start).split("\n").length - 1
  const endLine = buffer.text.slice(0, end).split("\n").length - 1
  const startCol = start - (buffer.text.lastIndexOf("\n", start - 1) + 1)
  const endCol = end - (buffer.text.lastIndexOf("\n", end - 1) + 1)
  const colA = Math.min(startCol, endCol)
  const colB = Math.max(startCol, endCol)
  const lines = buffer.text.split("\n")
  return { startLine, endLine, colA, colB, lines }
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
function moveByWord(buffer: CommandContext["buffer"], dir: 1 | -1): boolean {
  if (buffer.locals.has("word-forward-regexp") || buffer.locals.has("word-backward-regexp")) {
    const before = buffer.point
    buffer.moveWord(dir)
    return buffer.point !== before
  }
  if (dir > 0) {
    const m = /[\p{L}\p{M}\p{N}_]+/u.exec(buffer.text.slice(buffer.point))
    if (!m) {
      buffer.point = buffer.text.length
      return false
    }
    buffer.point = buffer.point + m.index + m[0].length
    return true
  } else {
    const matches = [...buffer.text.slice(0, buffer.point).matchAll(/[\p{L}\p{M}\p{N}_]+/gu)]
    const match = matches.at(-1)
    if (!match) {
      buffer.point = 0
      return false
    }
    buffer.point = match.index
    return true
  }
}
