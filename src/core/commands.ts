import { dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { appendFile, mkdir } from "node:fs/promises"
import type { SaveContext } from "../kernel/buffer"
import type { CommandContext } from "../kernel/command"
import type { Editor } from "../kernel/editor"
import { defaultTheme, disableBuiltinTheme, enableBuiltinTheme, getBuiltinTheme, isBuiltinThemeEnabled, listEnabledBuiltinThemes, themeSource } from "../themes"
import {
  diredCreateDirectory,
  makeDirectory,
  diredDoCopy,
  diredDoDelete,
  diredDoFlaggedDelete,
  diredDoRename,
  diredEntryAtPoint,
  diredFlagFileDeletion,
  diredMarkAll,
  diredMarkEntry,
  diredMarkFilesRegexp,
  diredToggleMark,
  diredUnmarkAll,
  diredUnmarkBackward,
  diredUnmarkEntry,
  refreshDiredBuffer,
} from "../modes/dired"
import { bufferListEntryAtPoint, showBufferList } from "../modes/buffer-list"
import { spawnProcess } from "../platform/runtime"
import { getMode } from "../modes/mode"
import { pythonBeginningOfDefun, pythonEndOfDefun } from "../modes/python"
import { defcustom, getCustom } from "../runtime/custom"
import { Evaluator } from "../runtime/evaluator"
import { installLiveSourceCommands } from "../runtime/live-source"
import { revertAllDefinitions } from "../runtime/patch-eval"
import { inspectValue } from "../runtime/inspect"
import { installEmacsStandardCommands, readKey, type KillRingApi } from "./emacs-standard"
import { isPrintable } from "../kernel/keymap"
import { listWindowLeaves, nextWindowId } from "../kernel/window"
import { pageScrollLines } from "../display/viewport"

defcustom("make-backup-files", "boolean", true,
  "Non-nil means make a backup of a file the first time it is saved.")

/** Register interactive commands only (no key bindings). */
export function installCoreCommands(editor: Editor): Evaluator {
  const evaluator = new Evaluator(editor)
  let killRing = ""
  let killRingHistory: string[] = []
  let yankRingIndex = 0
  let lastYankStart: number | null = null
  let lastYankEnd: number | null = null
  let lastCommandName: string | null = null

  editor.events.on("changed", ({ reason }) => {
    if (reason.startsWith("command:")) lastCommandName = reason.slice("command:".length)
  })
  const lastCommandWasKill = () => lastCommandName != null && KILL_COMMANDS.has(lastCommandName)

  const pushKill = (text: string, append = false, before = false) => {
    if (!text) return
    if (append && killRingHistory.length) {
      killRing = killRingHistory[0] = before ? text + killRingHistory[0]! : killRingHistory[0]! + text
      yankRingIndex = 0
      return
    }
    killRing = text
    killRingHistory.unshift(text)
    if (killRingHistory.length > 60) killRingHistory.length = 60
    yankRingIndex = 0
  }

  const killApi: KillRingApi = {
    pushKill,
    getKill: () => killRing,
    recordYank(buffer, text) {
      lastYankStart = buffer.point - text.length
      lastYankEnd = buffer.point
      yankRingIndex = 0
    },
    yankPop(buffer) {
      if (!killRingHistory.length) return
      yankRingIndex = (yankRingIndex + 1) % killRingHistory.length
      const text = killRingHistory[yankRingIndex]!
      killRing = text
      if (lastYankStart != null && lastYankEnd != null) {
        buffer.replaceRange(lastYankStart, lastYankEnd, text)
        lastYankEnd = lastYankStart + text.length
      } else {
        buffer.insert(text)
        lastYankStart = buffer.point - text.length
        lastYankEnd = buffer.point
      }
    },
  }

  // SaveContext shared by every command-layer save path so the mtime-clash
  // confirm and make-backup-files defcustom apply uniformly. Hooks are *not*
  // included by default — save-buffer's hooks are advice-driven and swallow
  // errors; callers that bypass that command (save-some-buffers) opt in.
  const saveCtx = (extra?: SaveContext): SaveContext => ({
    confirm: async (p: string) => (await readKey(editor, `${p} (y or n) `)) === "y",
    makeBackupFiles: getCustom("make-backup-files") as boolean,
    ...extra,
  })

  editor.command("save-buffer", async ({ buffer, editor }) => {
    try {
      await buffer.save(saveCtx())
      editor.message(`Saved ${buffer.path}`)
    } catch (err) {
      editor.message((err as Error).message)
    }
  }, "Save the current buffer to disk.")

  const findFile = async ({ editor, args }: CommandContext) => {
    const input = args[0] ?? await editor.completingRead("Find file: ", {
      completion: "file",
      history: "file",
      initialValue: directoryInitialValue(editor.currentBuffer.directory() ?? process.cwd()),
    })
    if (!input) return
    const path = substituteInFileName(input)
    await editor.openFile(path)
    editor.message(`Opened ${path}`)
  }

  editor.command("find-file", findFile, "Open a file into a buffer.")

  const cycleBuffer = (editor: Editor, delta: number) => {
    const values = [...editor.buffers.values()].filter(b => b.kind !== "minibuffer")
    const i = values.findIndex(b => b.id === editor.currentBufferId)
    return editor.switchToBuffer(values[(i + delta + values.length) % values.length]!.id)
  }

  editor.command("next-buffer", ({ editor }) => {
    const b = cycleBuffer(editor, 1)
    editor.message(`Switched to ${editor.bufferDisplayName(b)}`)
  }, "Switch to the next buffer.")

  editor.command("previous-buffer", ({ editor }) => {
    const b = editor.previousBuffer()
    editor.message(`Switched to ${editor.bufferDisplayName(b)}`)
  }, "Switch to the previous buffer.")

  editor.command("switch-to-buffer", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Switch to buffer: ", { collection: [...editor.buffers.values()].map(b => editor.bufferDisplayName(b)), history: "buffer" })
    if (!name) return
    const buffer = editor.switchToBuffer(name)
    editor.message(`Switched to ${editor.bufferDisplayName(buffer)}`)
  }, "Prompt for a buffer name and switch to it.")

  editor.command("list-buffers", ({ editor }) => {
    showBufferList(editor)
  }, "Display the buffer list.")

  editor.command("buffer-list-select", ({ buffer, editor }) => {
    const bufferId = bufferListEntryAtPoint(buffer)
    if (!bufferId) return
    const target = editor.buffers.get(bufferId)
    if (!target) return
    editor.switchToBuffer(target.id)
    editor.message(`Switched to ${editor.bufferDisplayName(target)}`)
  }, "Switch to the buffer on the current buffer-list line.")

  editor.command("set-mark-command", ({ buffer, editor }) => {
    buffer.setMark()
    editor.message(`Mark set at ${buffer.point}`)
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

  editor.command("keyboard-quit", ({ editor }) => {
    editor.keymaps.clearPending()
    editor.prefixArg.clear()
    if (editor.isearch) editor.cancelIsearch()
    if (editor.minibuffer) editor.minibufferCancel()
    editor.currentBuffer.clearMark()
    editor.message("Quit")
  }, "Cancel the active key sequence, minibuffer, isearch, or mark.")

  editor.command("isearch-forward", ({ editor }) => {
    if (editor.isearch?.direction === 1) editor.isearchRepeat()
    else editor.startIsearch(1)
  }, "Incremental search forward.")

  editor.command("isearch-backward", ({ editor }) => {
    if (editor.isearch?.direction === -1) editor.isearchRepeat()
    else editor.startIsearch(-1)
  }, "Incremental search backward.")

  editor.command("universal-argument", ({ editor }) => {
    const value = editor.prefixArg.universalArgument()
    editor.message(`C-u ${editor.prefixArg.isNegative() ? "-" : ""}${value}`)
  }, "Begin or multiply the numeric prefix argument.")
  editor.command("negative-argument", ({ editor }) => {
    editor.prefixArg.toggleNegative()
    editor.message(`Negative argument ${editor.prefixArg.describe()}`)
  }, "Set or invert the sign of the numeric prefix argument.")
  editor.command("digit-argument", ({ editor, args }) => {
    const digit = Number(args[0])
    if (!Number.isFinite(digit)) return
    const value = editor.prefixArg.addDigit(digit)
    const sign = editor.prefixArg.isNegative() ? "-" : ""
    editor.message(`Argument ${sign}${value}`)
  }, "Add a digit to the numeric prefix argument.")
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
  editor.command("previous-history-element", ({ editor }) => editor.minibufferPreviousHistory(), "Move to the previous minibuffer history element.")
  editor.command("next-history-element", ({ editor }) => editor.minibufferNextHistory(), "Move to the next minibuffer history element.")
  editor.command("forward-char", ({ buffer, prefixArgument }) => buffer.move(prefixArgument ?? 1), "Move point forward one character.")
  editor.command("backward-char", ({ buffer, prefixArgument }) => buffer.move(-(prefixArgument ?? 1)), "Move point backward one character.")
  editor.command("next-line", ({ buffer, prefixArgument }) => buffer.moveLine(prefixArgument ?? 1), "Move point down one line.")
  editor.command("previous-line", ({ buffer, prefixArgument }) => buffer.moveLine(-(prefixArgument ?? 1)), "Move point up one line.")
  editor.command("scroll-up-command", ({ editor, prefixArgument }) => scrollScreen(editor, true, prefixArgument ?? 1), "Scroll forward one screenful.")
  editor.command("scroll-down-command", ({ editor, prefixArgument }) => scrollScreen(editor, false, prefixArgument ?? 1), "Scroll backward one screenful.")
  editor.command("move-beginning-of-line", ({ buffer }) => buffer.moveToLineStart(), "Move point to the beginning of the line.")
  editor.command("move-end-of-line", ({ buffer }) => buffer.moveToLineEnd(), "Move point to the end of the line.")
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
  editor.command("newline", ({ buffer }) => buffer.insert("\n"), "Insert a newline at point.")
  editor.command("delete-char", ({ buffer, prefixArgument }) => repeat(prefixArgument, () => buffer.deleteForward(), () => buffer.deleteBackward()), "Delete the character after point.")
  editor.command("delete-backward-char", async ({ buffer, editor, prefixArgument }) => {
    if (editor.minibuffer) {
      const n = prefixArgument ?? 1
      const count = Math.max(1, Math.abs(n))
      for (let i = 0; i < count; i++) {
        if (n < 0) buffer.deleteForward()
        else await editor.minibufferBackspace()
      }
      return
    }
    repeat(prefixArgument, () => buffer.deleteBackward(), () => buffer.deleteForward())
  }, "Delete the character before point.")
  const killWords = (buffer: CommandContext["buffer"], n: number) => {
    const start = buffer.point
    const dir = n < 0 ? -1 : 1
    for (let i = 0; i < Math.abs(n); i++) moveByWord(buffer, dir)
    pushKill(buffer.deleteRange(start, buffer.point), lastCommandWasKill(), dir < 0)
  }
  editor.command("backward-kill-word", ({ buffer, prefixArgument }) => killWords(buffer, -(prefixArgument ?? 1)), "Kill the word before point.")
  editor.command("kill-word", ({ buffer, prefixArgument }) => killWords(buffer, prefixArgument ?? 1), "Kill the word after point.")
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
  editor.command("kill-region", ({ buffer }) => {
    if (buffer.mark == null || buffer.mark === buffer.point) {
      const line = buffer.lineBoundsAt()
      const end = line.end < buffer.text.length ? line.end + 1 : line.end
      killApi.pushKill(buffer.deleteRange(line.start, end))
      return
    }
    killApi.pushKill(buffer.deleteRange(buffer.mark, buffer.point))
    buffer.clearMark()
  }, "Kill the active region, or the current line when no region is active.")
  editor.command("kill-ring-save", ({ buffer, editor }) => {
    const selected = buffer.selectedText() || buffer.lineBoundsAt().text + (buffer.lineBoundsAt().end < buffer.text.length ? "\n" : "")
    killApi.pushKill(selected)
    editor.message(buffer.selectedText() ? "Copied region" : "Copied line")
  }, "Copy the active region, or the current line when no region is active.")
  editor.command("yank", ({ buffer }) => {
    const text = killRing
    if (!text) return
    buffer.insert(text)
    killApi.recordYank(buffer, text)
  }, "Insert the last killed text at point.")

  editor.command("undo", ({ buffer }) => buffer.undo(), "Undo the last text edit.")
  editor.command("redo", ({ buffer }) => buffer.redo(), "Redo the last undone text edit.")

  editor.command("goto-line", async ({ buffer, editor, args }) => {
    const value = args[0] ?? await editor.prompt("Goto line: ", "", "goto-line")
    const line = Math.max(1, Number(value) || 1)
    const lines = buffer.text.split("\n")
    const offset = lines.slice(0, line - 1).reduce((offset, text) => offset + text.length + 1, 0)
    buffer.point = Math.min(offset, buffer.text.length)
  }, "Move point to a line number.")

  editor.command("point-to-register", async ({ buffer, editor, args }) => {
    const register = args[0] ?? await editor.prompt("Point to register: ", "f", "register")
    if (!register) return
    editor.registers.set(register, { kind: "point", point: buffer.point, bufferId: buffer.id })
    editor.message(`Saved point ${buffer.point} to register ${register}`)
  }, "Save point to a register.")

  editor.command("jump-to-register", async ({ editor, args }) => {
    const register = args[0] ?? await editor.prompt("Jump to register: ", "f", "register")
    if (!register) return
    const value = editor.registers.get(register)
    if (!value) { editor.message(`Register ${register} is empty`); return }
    if (value.kind === "point") {
      if (value.bufferId && editor.buffers.has(value.bufferId)) editor.switchToBuffer(value.bufferId)
      const buffer = editor.currentBuffer
      buffer.point = Math.max(0, Math.min(value.point, buffer.text.length))
      editor.setSelectedWindowPoint(buffer.point)
      return
    }
    editor.restoreWindowConfiguration(value)
  }, "Jump to a saved point or window configuration register.")

  editor.command("window-configuration-to-register", async ({ editor, args }) => {
    const register = args[0] ?? await editor.prompt("Window configuration to register: ", "w", "register")
    if (!register) return
    editor.registers.set(register, editor.currentWindowConfiguration())
    editor.message(`Saved window configuration to register ${register}`)
  }, "Save the current window configuration to a register.")

  editor.command("scroll-other-window", ({ editor, prefixArgument }) => {
    if (!editor.scrollOtherWindow(prefixArgument ?? 1)) editor.message("No other window to scroll")
  }, "Scroll the next window forward without selecting it.")

  editor.command("scroll-other-window-down", ({ editor, prefixArgument }) => {
    if (!editor.scrollOtherWindow(-(prefixArgument ?? 1))) editor.message("No other window to scroll")
  }, "Scroll the next window backward without selecting it.")

  editor.command("switch-to-buffer-other-window", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Switch to buffer in other window: ", {
      collection: [...editor.buffers.values()].map(b => editor.bufferDisplayName(b)),
      history: "buffer",
    })
    if (!name) return
    const target = editor.buffers.get(name)
      ?? [...editor.buffers.values()].find(b => b.name === name || editor.bufferDisplayName(b) === name)
    const shown = editor.displayBufferInOtherWindow(target?.id ?? name)
    editor.message(`Switched to ${editor.bufferDisplayName(shown)} in other window`)
  }, "Switch to a buffer in another window.")

  editor.command("find-file-other-window", async ({ editor, args }) => {
    const input = args[0] ?? await editor.completingRead("Find file in other window: ", {
      completion: "file",
      history: "file",
      initialValue: directoryInitialValue(editor.currentBuffer.directory() ?? process.cwd()),
    })
    if (!input) return
    editor.ensureOtherWindowSelected()
    const buffer = await editor.openFile(substituteInFileName(input))
    editor.message(`Now visiting ${editor.bufferDisplayName(buffer)} in other window`)
  }, "Find a file in another window.")

  editor.command("display-buffer-other-window", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Display buffer in other window: ", {
      collection: [...editor.buffers.values()].map(b => editor.bufferDisplayName(b)),
      history: "buffer",
      initialValue: editor.bufferDisplayName(editor.currentBuffer),
    })
    if (!name) return
    const target = editor.buffers.get(name)
      ?? [...editor.buffers.values()].find(b => b.name === name || editor.bufferDisplayName(b) === name)
    const shown = editor.displayBufferInOtherWindow(target?.id ?? name)
    editor.message(`Displayed ${editor.bufferDisplayName(shown)} in other window`)
  }, "Display a buffer in another window and select it.")

  editor.command("toggle-window-dedicated", ({ editor }) => {
    const leaf = editor.selectedWindowLeaf()
    const dedicated = !(leaf?.dedicated ?? false)
    editor.setSelectedWindowDedicated(dedicated)
    editor.message(dedicated ? "Window is now dedicated" : "Window is no longer dedicated")
  }, "Toggle whether the selected window is dedicated.")

  editor.command("replace-string", async ({ buffer, editor, args }) => {
    const from = args[0] ?? await editor.prompt("Replace string: ", "", "replace")
    if (!from) return
    const to = args[1] ?? await editor.prompt(`Replace ${from} with: `, "", "replace")
    if (to == null) return
    const region = buffer.mark == null || buffer.mark === buffer.point ? { start: 0, end: buffer.text.length } : { start: Math.min(buffer.mark, buffer.point), end: Math.max(buffer.mark, buffer.point) }
    const replaced = buffer.text.slice(region.start, region.end).split(from).join(to)
    buffer.replaceRange(region.start, region.end, replaced)
  }, "Replace a string in the region or current buffer.")

  editor.command("eval-region", async ({ buffer, editor }) => {
    const code = buffer.selectedOrAll()
    const result = await evaluator.eval(code, buffer.path ?? buffer.name)
    editor.message(`Eval => ${summarize(result)}`)
    return result
  }, "Evaluate the selection, or the whole buffer if no selection is active.")

  editor.command("eval-expression", async ({ editor, args }) => {
    const expression = args.join(" ") || await editor.prompt("Eval expression: ", "", "eval-expression")
    if (!expression) return
    const result = await evaluator.evalExpression(expression)
    editor.scratch("*eval-result*", inspectValue(result), "text")
  }, "Evaluate a JavaScript expression and display its result.")

  editor.command("execute-extended-command", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("M-x ", { collection: editor.commands.names(), history: "command" })
    if (!name) return
    const rest = args.length > 1 ? args.slice(1) : []
    await editor.run(name, rest)
  }, "Prompt for and run a command.")

  editor.command("view-echo-area-messages", ({ editor }) => {
    editor.switchToBuffer("*messages*")
  }, "Display the messages buffer.")

  editor.command("describe-key-briefly", async ({ editor, args }) => {
    const sequence = args.join(" ") || await editor.prompt("Describe key briefly: ", "", "describe-key-briefly")
    if (!sequence) return
    editor.message(editor.describeKey(sequence))
  }, "Type a key sequence; print its full command name in the echo area.")

  editor.command("describe-bindings", ({ editor }) => {
    const lines = editor.keymap.all().map(([k, v]) => `${k.padEnd(16)} ${v}`)
    editor.scratch("*Help*", lines.join("\n"), "text")
  }, "Describe key bindings of the current keymap.")

  editor.command("minibuffer-complete", async ({ editor }) => editor.minibufferComplete(), "Complete the current minibuffer input.")
  editor.command("exit-minibuffer", ({ editor }) => editor.minibufferSubmit(), "Submit the minibuffer.")
  editor.command("abort-recursive-edit", ({ editor }) => editor.minibufferCancel(), "Abort the minibuffer or recursive edit.")

  editor.command("indent-for-tab-command", async ({ editor, buffer }) => {
    if (!await editor.completeAtPoint(buffer)) editor.indentLine(buffer)
  }, "Complete the symbol at point, or indent the current line.")

  editor.command("newline-and-indent", ({ editor, buffer }) => {
    buffer.insert("\n")
    editor.indentLine(buffer)
  }, "Insert a newline, then indent according to the current major mode.")

  editor.command("python-beginning-of-defun", ({ buffer }) => pythonBeginningOfDefun(buffer), "Move to the beginning of the current Python def or class.")
  editor.command("python-end-of-defun", ({ buffer }) => pythonEndOfDefun(buffer), "Move to the end of the current Python def or class.")
  editor.command("python-shell-switch-to-shell", ({ editor }) => {
    editor.scratch("*Python*", "Python shell integration is not implemented yet.\n", "text")
  }, "Switch to the Python shell buffer placeholder.")

  editor.command("dired", async ({ editor, args }) => {
    const path = args[0] ?? await editor.completingRead("Dired: ", { completion: "file", history: "file", initialValue: directoryInitialValue(editor.currentBuffer.directory() ?? process.cwd()) })
    if (!path) return
    await editor.openDirectory(substituteInFileName(path))
  }, "Open a directory in Dired.")
  editor.command("dired-revert", async ({ buffer, editor }) => {
    await refreshDiredBuffer(buffer)
    editor.message(`Reverted ${buffer.path}`)
  }, "Refresh the current Dired buffer.")
  editor.command("dired-find-file", async ({ buffer, editor }) => {
    const entry = diredEntryAtPoint(buffer)
    if (!entry) return
    await editor.openFile(entry.path)
  }, "Visit the file or directory on the current Dired line.")
  editor.command("dired-up-directory", async ({ buffer, editor }) => {
    if (!buffer.path) return
    await editor.openDirectory(dirname(buffer.path))
  }, "Open the parent directory in Dired.")
  editor.command("dired-mark", ({ buffer }) => {
    diredMarkEntry(buffer, diredEntryAtPoint(buffer), "marked")
  }, "Mark the current Dired line.")
  editor.command("dired-unmark", ({ buffer }) => {
    diredUnmarkEntry(buffer, diredEntryAtPoint(buffer))
  }, "Unmark the current Dired line.")
  editor.command("dired-unmark-all", ({ buffer, editor }) => {
    diredUnmarkAll(buffer)
    editor.message("Unmarked all")
  }, "Remove all marks and deletion flags in Dired.")
  editor.command("dired-toggle-mark", ({ buffer }) => {
    diredToggleMark(buffer, diredEntryAtPoint(buffer))
  }, "Toggle the mark on the current Dired line.")
  editor.command("dired-mark-all", ({ buffer, editor }) => {
    diredMarkAll(buffer)
    editor.message("Marked all files")
  }, "Mark all files in this Dired buffer.")
  editor.command("dired-mark-files-regexp", async ({ buffer, editor, args }) => {
    const regexp = args[0] ?? await editor.prompt("% m Mark files (regexp): ", "", "dired-regexp")
    if (!regexp) return
    const count = diredMarkFilesRegexp(buffer, regexp, "marked")
    editor.message(`Marked ${count} file(s)`)
  }, "Mark files whose names match a regular expression.")
  editor.command("dired-flag-files-regexp", async ({ buffer, editor, args }) => {
    const regexp = args[0] ?? await editor.prompt("% d Flag files (regexp): ", "", "dired-regexp")
    if (!regexp) return
    const count = diredMarkFilesRegexp(buffer, regexp, "delete")
    editor.message(`Flagged ${count} file(s) for deletion`)
  }, "Flag files for deletion by regular expression.")
  editor.command("dired-flag-file-deletion", ({ buffer }) => {
    diredFlagFileDeletion(buffer, diredEntryAtPoint(buffer))
  }, "Flag the current Dired line for deletion.")
  editor.command("dired-do-flagged-delete", async ({ buffer, editor }) => {
    await diredDoFlaggedDelete(editor, buffer)
  }, "Delete files flagged for deletion in Dired.")
  editor.command("dired-do-delete", async ({ buffer, editor, prefixArgument }) => {
    await diredDoDelete(editor, buffer, prefixArgument)
  }, "Delete file on the current line or marked files.")
  editor.command("dired-do-copy", async ({ buffer, editor, prefixArgument }) => {
    await diredDoCopy(editor, buffer, prefixArgument)
  }, "Copy marked files or the file on the current line.")
  editor.command("dired-do-rename", async ({ buffer, editor, prefixArgument }) => {
    await diredDoRename(editor, buffer, prefixArgument)
  }, "Rename a file or move marked files to another directory.")
  editor.command("make-directory", async ({ buffer, editor, args }) => {
    const parent = buffer.directory() ?? process.cwd()
    await makeDirectory(editor, parent, args[0], buffer.kind === "directory" ? buffer : undefined)
  }, "Create a new directory.")
  editor.command("dired-create-directory", async ({ buffer, editor, args }) => {
    if (!buffer.path || buffer.kind !== "directory") {
      editor.message("Not in Dired")
      return
    }
    await diredCreateDirectory(editor, buffer, args[0])
  }, "Create a new directory in the current Dired listing.")
  editor.command("dired-unmark-backward", ({ buffer }) => {
    diredUnmarkBackward(buffer)
  }, "Move up one line and unmark or unflag.")
  editor.command("quit-window", ({ editor }) => {
    editor.deleteWindow()
    if (editor.windows.length === 1) cycleBuffer(editor, 1)
  }, "Bury the current special buffer and select another buffer.")

  const otherWindow = (editor: Editor, delta: number) => {
    if (listWindowLeaves(editor.windowLayout).length <= 1) return
    editor.selectWindow(nextWindowId(editor.windowLayout, editor.selectedWindowId, delta))
  }
  editor.command("delete-window", ({ editor }) => editor.deleteWindow(), "Delete the selected window.")
  editor.command("other-window", ({ editor }) => otherWindow(editor, 1), "Select another window.")
  editor.command("other-window-backward", ({ editor }) => otherWindow(editor, -1), "Select the previous window in the cycle.")
  editor.command("next-window-any-frame", ({ editor }) => otherWindow(editor, 1), "Select the next window.")
  editor.command("previous-window-any-frame", ({ editor }) => otherWindow(editor, -1), "Select the previous window.")
  editor.command("tab-bar-new-tab", ({ editor }) => {
    editor.tabs.push({ name: String(editor.tabs.length + 1), bufferId: editor.currentBufferId })
    editor.selectedTab = editor.tabs.length - 1
  }, "Create a new tab.")
  editor.command("tab-bar-close-tab", ({ editor }) => {
    if (editor.tabs.length <= 1) return
    editor.tabs.splice(editor.selectedTab, 1)
    editor.selectedTab = Math.min(editor.selectedTab, editor.tabs.length - 1)
    editor.switchToBuffer(editor.tabs[editor.selectedTab]!.bufferId)
  }, "Close the current tab.")
  const switchTab = (editor: Editor, delta: number) => {
    if (!editor.tabs.length) return
    editor.selectedTab = (editor.selectedTab + delta + editor.tabs.length) % editor.tabs.length
    editor.switchToBuffer(editor.tabs[editor.selectedTab]!.bufferId)
  }
  editor.command("tab-bar-switch-to-next-tab", ({ editor }) => switchTab(editor, 1), "Switch to the next tab.")
  editor.command("tab-bar-switch-to-prev-tab", ({ editor }) => switchTab(editor, -1), "Switch to the previous tab.")
  editor.command("tiling-cycle", ({ editor }) => {
    const layouts = ["tiling-master-left", "tiling-master-top", "tiling-even-horizontal", "tiling-even-vertical", "tiling-tile-4"]
    editor.tilingLayout = layouts[(layouts.indexOf(editor.tilingLayout) + 1) % layouts.length]!
    editor.message(`Layout ${editor.tilingLayout}`)
  }, "Cycle Jemacs tiling layouts.")

  editor.command("load-theme", ({ editor, args }) => {
    const name = args[0]?.trim()
    if (name) {
      const theme = enableBuiltinTheme(name)
      if (!theme) {
        editor.message(`Unknown theme: ${name}`)
        return
      }
      editor.setTheme(theme)
    } else {
      editor.setTheme(editor.theme)
    }
    editor.message(`Loaded theme ${editor.theme.name}`)
  }, "Load a built-in theme by name, or reload the active theme.")

  editor.command("enable-theme", async ({ editor, args }) => {
    const name = args[0]?.trim() || themeNameAtPoint(editor)
    if (!name) {
      editor.message("No theme specified")
      return
    }
    if (!args[0] && isBuiltinThemeEnabled(name)) {
      disableBuiltinTheme(name)
      const active = listEnabledBuiltinThemes().at(-1)
      editor.setTheme(active ? getBuiltinTheme(active)! : defaultTheme)
      await refreshThemeBufferIfCurrent(editor)
      editor.message(`Disabled theme ${name}`)
      return
    }
    const theme = enableBuiltinTheme(name)
    if (!theme) {
      editor.message(`Unknown theme: ${name}`)
      return
    }
    editor.setTheme(theme)
    await refreshThemeBufferIfCurrent(editor)
    editor.message(`Enabled theme ${name}`)
  }, "Enable a built-in theme.")

  editor.command("disable-theme", async ({ editor, args }) => {
    const name = args[0]?.trim() || themeNameAtPoint(editor)
    if (!name) {
      editor.message("No theme specified")
      return
    }
    if (!getBuiltinTheme(name)) {
      editor.message(`Unknown theme: ${name}`)
      return
    }
    disableBuiltinTheme(name)
    const enabled = listEnabledBuiltinThemes()
    const active = enabled.at(-1)
    editor.setTheme(active ? getBuiltinTheme(active)! : defaultTheme)
    await refreshThemeBufferIfCurrent(editor)
    editor.message(`Disabled theme ${name}`)
  }, "Disable a built-in theme.")

  editor.command("describe-theme", ({ editor, args }) => {
    const name = args[0]?.trim() || themeNameAtPoint(editor)
    if (!name) {
      editor.message("No theme specified")
      return
    }
    const theme = getBuiltinTheme(name)
    if (!theme) {
      editor.message(`Unknown theme: ${name}`)
      return
    }
    editor.scratch("*Help*", [
      `${name} theme`,
      "",
      `${themeSource(name)} Custom theme.`,
      "",
      `Faces: ${Object.keys(theme.faces).sort().join(", ")}`,
    ].join("\n"), "help")
  }, "Describe a Custom theme.")

  editor.command("fzf-git", async ({ editor, args }) => {
    const query = args[0] ?? ""
    const proc = spawnProcess({ cmd: ["git", "ls-files"], cwd: process.cwd(), stdout: "pipe", stderr: "pipe" })
    const output = proc.stdout ? await new Response(proc.stdout).text() : ""
    const files = output.split("\n").filter(file => file && file.includes(query))
    const choice = args[1] ?? await editor.completingRead("Git file: ", { collection: files, history: "file", initialValue: query })
    if (choice) await editor.openFile(choice)
  }, "Find a tracked Git file with completion.")

  editor.command("counsel-ag", async ({ editor, args }) => {
    const pattern = args[0] ?? await editor.prompt("Search project: ", "", "search")
    if (!pattern) return
    const proc = spawnProcess({
      cmd: ["rg", "--line-number", "--column", "--no-heading", "--", pattern],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
    ])
    const exit = await proc.exited
    const text = exit === 0 || stdout ? stdout : stderr
    editor.scratch("*grep*", text || "No matches\n", "text").kind = "grep"
  }, "Search the project with ripgrep.")

  editor.command("copy-region-to-clipboard-mac", async ({ buffer, editor }) => {
    const text = buffer.selectedText() || buffer.lineBoundsAt().text
    const pbcopy = spawnProcess({ cmd: ["pbcopy"], stdin: "pipe" })
    pbcopy.stdin?.write(text)
    pbcopy.stdin?.end()
    await pbcopy.exited
    killApi.pushKill(text)
    editor.message("Copied text to clipboard")
  }, "Copy region or current line to the macOS clipboard.")

  editor.command("i-bind-key", async ({ editor, args }) => {
    const sequence = args[0] ?? await editor.prompt("Key sequence to bind: ", "", "keybind")
    if (!sequence) return
    const command = args[1] ?? await editor.completingRead(`Command to bind to ${sequence}: `, { collection: editor.commands.names(), history: "command" })
    if (!command) return
    if (!editor.commands.get(command)) throw new Error(`Not an interactive command: ${command}`)
    editor.key(sequence, command)
    const file = resolve(process.env.JEMACS_KEYBINDS_FILE ?? `${homedir()}/.jemacs/keybinds.js`)
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `// Added on ${new Date().toISOString()}\neditor.key(${JSON.stringify(sequence)}, ${JSON.stringify(command)})\n`)
    editor.message(`Bound ${sequence} to ${command} and saved it to ${file}`)
  }, "Interactively bind a key and persist it to the Jemacs keybinds file.")

  editor.command("load-plugin", async ({ editor, args }) => {
    const path = args[0] ?? await editor.completingRead("Load plugin: ", { completion: "file", history: "file", initialValue: "plugins/demo-plugin.ts" })
    if (!path) return
    await evaluator.loadPlugin(path)
    editor.message(`Loaded plugin ${path}`)
  }, "Load a plugin module exporting install(editor).")

  editor.command("reload-current-file", async ({ buffer, editor }) => {
    if (!buffer.path) {
      editor.message("Current buffer is not visiting a file")
      return
    }
    revertAllDefinitions(editor)
    if (buffer.dirty) {
      try { await buffer.save(saveCtx()) }
      catch (err) { editor.message((err as Error).message); return }
    }
    const display = editor.bufferDisplayName(buffer)
    const mod = await evaluator.loadModule(buffer.path)
    if (typeof mod.install === "function") {
      await mod.install(editor)
      editor.message(`Reloaded ${display} via install(editor)`)
      return
    }
    if (typeof mod.installDefaultConfig === "function") {
      mod.installDefaultConfig(editor)
      editor.message(`Reloaded ${display} via installDefaultConfig(editor)`)
    } else if (typeof mod.installDefaultCommands === "function") {
      mod.installDefaultCommands(editor)
      editor.message(`Reloaded ${display} via installDefaultCommands(editor)`)
      return
    }
    editor.message(`Reloaded ${display}; no installer export found`)
  }, "Save and reload the current TypeScript/JavaScript file into the live editor.")

  editor.command("save-some-buffers", async ({ editor }) => {
    const dirty = [...editor.buffers.values()].filter(b => b.dirty && b.path && b.kind === "file")
    let saveAll = false
    let saved = 0
    const runHook = editor.runHook.bind(editor)
    for (const b of dirty) {
      // Buffers with buffer-save-without-query set save silently (files.el:6370).
      if (b.locals.get("buffer-save-without-query")) { await b.save(saveCtx({ runHook, force: true })); saved++; continue }
      let answer = saveAll ? "y" : (await editor.prompt(`Save file ${b.path}? (y, n, !, ., q) `, "", "save-some-buffers"))?.trim()
      if (answer == null || answer === "q") break
      if (answer === "!") { saveAll = true; answer = "y" }
      if (answer === "y" || answer === ".") { await b.save(saveCtx({ runHook })); saved++ }
      if (answer === ".") break
    }
    editor.message(dirty.length ? `Saved ${saved} of ${dirty.length} file(s)` : "(No files need saving)")
  }, "Save some modified file-visiting buffers, asking about each one.")
  editor.key("C-x s", "save-some-buffers")

  editor.command("save-buffers-kill-terminal", async ({ editor }) => {
    await editor.run("save-some-buffers")
    // Declining a save above must not silently discard edits (files.el:8212).
    if ([...editor.buffers.values()].some(b => b.dirty && b.path)) {
      if ((await readKey(editor, "Modified buffers exist; exit anyway? (y or n) ")) !== "y") return
    }
    editor.message("Quit requested")
    editor.quit()
  }, "Offer to save modified buffers, then quit the editor.")

  installEmacsStandardCommands(editor, killApi)

  // Registered after installEmacsStandardCommands so this is the canonical revert-buffer.
  editor.command("revert-buffer", async ({ buffer, editor, args }) => {
    if (!buffer.path) {
      editor.message("Current buffer is not visiting a file")
      return
    }
    // Emacs gates on confirmation when modified (files.el:7102); auto-revert passes noconfirm to bypass.
    if (buffer.dirty && !args[0]) {
      const ans = await readKey(editor, `Discard edits and reread from ${buffer.path}? (y or n) `)
      if (ans !== "y") { editor.message("Revert cancelled"); return }
    }
    await buffer.revert()
    buffer.point = Math.min(buffer.point, buffer.text.length)
    editor.message(`Reverted ${editor.bufferDisplayName(buffer)}`)
  }, "Reload the current file from disk, confirming first if the buffer is modified.")
  installLiveSourceCommands(editor, evaluator)

  return evaluator
}

/** Scroll selected window by `screens` pages and move point with it (Emacs scroll-up/down). */
function scrollScreen(editor: Editor, forward: boolean, screens: number): void {
  const leaf = editor.selectedWindowLeaf()
  if (!leaf) return
  const buffer = editor.currentBuffer
  const lines = buffer.text.split("\n")
  const delta = (forward ? 1 : -1) * pageScrollLines() * screens
  editor.setSelectedWindowStartLine(Math.max(0, Math.min(lines.length - 1, leaf.startLine + delta)))
  const { line, col } = buffer.lineCol()
  const targetLine = Math.max(0, Math.min(lines.length - 1, line - 1 + delta))
  let offset = 0
  for (let i = 0; i < targetLine; i++) offset += lines[i]!.length + 1
  buffer.point = Math.max(0, Math.min(buffer.text.length, offset + Math.min(col - 1, lines[targetLine]!.length)))
  buffer.deactivateMark()
}

function repeat(prefixArgument: number | null, fwd: () => void, bwd?: () => void): void {
  const n = prefixArgument ?? 1
  const fn = n < 0 ? (bwd ?? fwd) : fwd
  for (let i = 0; i < Math.abs(n); i++) fn()
}

const KILL_COMMANDS = new Set(["kill-line", "kill-word", "backward-kill-word", "kill-region"])

/** Emacs `substitute-in-file-name`: typing an absolute path or `~` after the
 *  prefilled directory restarts from there, so `/a/b//etc/x` → `/etc/x`.
 *  A leading `~` is expanded so node:path `resolve()` doesn't treat it as a
 *  literal directory component. */
export function substituteInFileName(input: string): string {
  const restart = Math.max(input.lastIndexOf("//"), input.lastIndexOf("/~"))
  const stripped = restart >= 0 ? input.slice(restart + 1) : input
  if (stripped === "~" || stripped.startsWith("~/")) return homedir() + stripped.slice(1)
  return stripped
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

function directoryInitialValue(directory: string): string {
  return directory.endsWith("/") ? directory : `${directory}/`
}

function themeNameAtPoint(editor: Editor): string | null {
  if (!editor.currentBuffer.locals.get("jemacs-customize-theme")) return null
  const line = editor.currentBuffer.lineBoundsAt().text
  const direct = /^Theme:\s+(.+?)\s+\[/.exec(line)?.[1]
  if (direct && getBuiltinTheme(direct.trim())) return direct.trim()
  const before = editor.currentBuffer.text.slice(0, editor.currentBuffer.point)
  const matches = [...before.matchAll(/^Theme:\s+(.+?)\s+\[/gm)]
  const name = matches.at(-1)?.[1]?.trim()
  return name && getBuiltinTheme(name) ? name : null
}

async function refreshThemeBufferIfCurrent(editor: Editor): Promise<void> {
  if (!editor.currentBuffer.locals.get("jemacs-customize-theme")) return
  await editor.run("customize-themes")
}

function summarize(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.slice(0, 80))
  if (typeof value === "undefined") return "undefined"
  if (value === null) return "null"
  if (typeof value === "object") return value.constructor?.name ?? "object"
  return String(value)
}
