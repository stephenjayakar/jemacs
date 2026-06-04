import { dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { access, appendFile, mkdir } from "node:fs/promises"
import type { CommandContext } from "../kernel/command"
import type { Editor } from "../kernel/editor"
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
import { getMode } from "../modes/mode"
import { pythonBeginningOfDefun, pythonEndOfDefun } from "../modes/python"
import { Evaluator } from "../runtime/evaluator"
import { inspectValue } from "../runtime/inspect"
import { installEmacsStandardCommands, type KillRingApi } from "./emacs-standard"
import { isPrintable } from "../kernel/keymap"

/** Register interactive commands only (no key bindings). */
export function installCoreCommands(editor: Editor): Evaluator {
  const evaluator = new Evaluator(editor)
  let killRing = ""
  let killRingHistory: string[] = []
  let yankRingIndex = 0
  let lastYankStart: number | null = null
  let lastYankEnd: number | null = null

  const killApi: KillRingApi = {
    pushKill(text: string) {
      if (!text) return
      killRing = text
      killRingHistory.unshift(text)
      if (killRingHistory.length > 60) killRingHistory.length = 60
      yankRingIndex = 0
    },
    getKill: () => killRing,
    recordYank(buffer, text) {
      lastYankStart = buffer.point
      lastYankEnd = buffer.point + text.length
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

  editor.command("save-buffer", async ({ buffer, editor }) => {
    await buffer.save()
    editor.message(`Saved ${buffer.path}`)
  }, "Save the current buffer to disk.")

  const findFile = async ({ editor, args }: CommandContext) => {
    const path = args[0] ?? await editor.completingRead("Find file: ", {
      completion: "file",
      history: "file",
      initialValue: editor.currentBuffer.directory() ?? process.cwd(),
    })
    if (!path) return
    await editor.openFile(path)
    editor.message(`Opened ${path}`)
  }

  editor.command("find-file", findFile, "Open a file into a buffer.")

  editor.command("next-buffer", ({ editor }) => {
    const b = editor.nextBuffer()
    editor.message(`Switched to ${b.name}`)
  }, "Switch to the next buffer.")

  editor.command("previous-buffer", ({ editor }) => {
    const b = editor.previousBuffer()
    editor.message(`Switched to ${b.name}`)
  }, "Switch to the previous buffer.")

  editor.command("switch-to-buffer", async ({ editor, args }) => {
    const current = editor.currentBuffer.name
    const name = args[0] ?? await editor.completingRead("Switch to buffer: ", { collection: [...editor.buffers.values()].map(b => b.name), history: "buffer", initialValue: current })
    if (!name) return
    const buffer = editor.switchToBuffer(name)
    editor.message(`Switched to ${buffer.name}`)
  }, "Prompt for a buffer name and switch to it.")

  editor.command("list-buffers", ({ editor }) => {
    const lines = [...editor.buffers.values()].map(buffer => {
      const current = buffer.id === editor.currentBufferId ? "." : " "
      const dirty = buffer.dirty ? "*" : " "
      const path = buffer.path ? `  ${buffer.path}` : ""
      return `${current}${dirty}  ${buffer.name.padEnd(24)} ${buffer.mode}${path}`
    })
    editor.scratch("*Buffer List*", lines.join("\n"), "text")
  }, "Display the buffer list.")

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
    editor.keymap.clearPending()
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

  editor.command("universal-argument", ({ editor }) => editor.universalArgument(), "Begin or multiply the numeric prefix argument.")
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
  editor.command("self-insert-command", ({ buffer, editor, prefixArgument }) => {
    const key = editor.lastKeyEvent
    if (!key) return
    if (editor.quotedInsertNext && isPrintable(key)) {
      editor.quotedInsertNext = false
      buffer.insert(key.sequence ?? "")
      return
    }
    if (!isPrintable(key)) return
    const count = Math.max(1, Math.abs(prefixArgument ?? 1))
    buffer.insert((key.sequence ?? "").repeat(count))
  }, "Insert the character you type.")
  editor.command("previous-history-element", ({ editor }) => editor.minibufferPreviousHistory(), "Move to the previous minibuffer history element.")
  editor.command("next-history-element", ({ editor }) => editor.minibufferNextHistory(), "Move to the next minibuffer history element.")
  editor.command("forward-char", ({ buffer, prefixArgument }) => buffer.move(prefixArgument ?? 1), "Move point forward one character.")
  editor.command("backward-char", ({ buffer, prefixArgument }) => buffer.move(-(prefixArgument ?? 1)), "Move point backward one character.")
  editor.command("next-line", ({ buffer, prefixArgument }) => buffer.moveLine(prefixArgument ?? 1), "Move point down one line.")
  editor.command("previous-line", ({ buffer, prefixArgument }) => buffer.moveLine(-(prefixArgument ?? 1)), "Move point up one line.")
  editor.command("scroll-up-command", ({ editor, prefixArgument }) => editor.scrollScreen(true, prefixArgument ?? 1), "Scroll forward one screenful.")
  editor.command("scroll-down-command", ({ editor, prefixArgument }) => editor.scrollScreen(false, prefixArgument ?? 1), "Scroll backward one screenful.")
  editor.command("move-beginning-of-line", ({ buffer }) => buffer.moveToLineStart(), "Move point to the beginning of the line.")
  editor.command("move-end-of-line", ({ buffer }) => buffer.moveToLineEnd(), "Move point to the end of the line.")
  editor.command("forward-word", ({ buffer, prefixArgument }) => repeat(prefixArgument, () => buffer.moveWord(1)), "Move point forward one word.")
  editor.command("backward-word", ({ buffer, prefixArgument }) => repeat(prefixArgument, () => buffer.moveWord(-1)), "Move point backward one word.")
  editor.command("newline", ({ buffer }) => buffer.insert("\n"), "Insert a newline at point.")
  editor.command("delete-char", ({ buffer, prefixArgument }) => repeat(prefixArgument, () => buffer.deleteForward()), "Delete the character after point.")
  editor.command("delete-backward-char", ({ buffer, prefixArgument }) => repeat(prefixArgument, () => buffer.deleteBackward()), "Delete the character before point.")
  editor.command("backward-kill-word", ({ buffer, prefixArgument }) => {
    let killed = ""
    repeat(prefixArgument, () => {
      const end = buffer.point
      buffer.moveWord(-1)
      killed = buffer.deleteRange(buffer.point, end) + killed
    })
    killApi.pushKill(killed)
  }, "Kill the word before point.")
  editor.command("kill-word", ({ buffer, prefixArgument }) => {
    let killed = ""
    repeat(prefixArgument, () => {
      const start = buffer.point
      buffer.moveWord(1)
      killed += buffer.deleteRange(start, buffer.point)
    })
    killApi.pushKill(killed)
  }, "Kill the word after point.")
  editor.command("kill-line", ({ buffer }) => {
    const lineEnd = buffer.text.indexOf("\n", buffer.point)
    const end = lineEnd === -1 ? buffer.text.length : lineEnd + (lineEnd === buffer.point ? 1 : 0)
    killApi.pushKill(buffer.deleteRange(buffer.point, end))
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
    buffer.point = lines.slice(0, line - 1).reduce((offset, text) => offset + text.length + 1, 0)
  }, "Move point to a line number.")

  editor.command("revert-buffer", async ({ buffer, editor }) => {
    if (!buffer.path) {
      editor.message("Current buffer is not visiting a file")
      return
    }
    const text = await Bun.file(buffer.path).text()
    buffer.setText(text, false)
    buffer.dirty = false
    buffer.point = Math.min(buffer.point, buffer.text.length)
    editor.message(`Reverted ${buffer.name}`)
  }, "Reload the current file from disk.")

  editor.command("point-to-register", async ({ buffer, editor, args }) => {
    const register = args[0] ?? await editor.prompt("Point to register: ", "f", "register")
    if (!register) return
    editor.registers.set(register, { kind: "point", point: buffer.point })
    editor.message(`Saved point ${buffer.point} to register ${register}`)
  }, "Save point to a register.")

  editor.command("jump-to-register", async ({ editor, args }) => {
    const register = args[0] ?? await editor.prompt("Jump to register: ", "f", "register")
    if (!register) return
    if (!editor.jumpToRegister(register)) editor.message(`Register ${register} is empty`)
  }, "Jump to a saved point or window configuration register.")

  editor.command("window-configuration-to-register", async ({ editor, args }) => {
    const register = args[0] ?? await editor.prompt("Window configuration to register: ", "w", "register")
    if (!register) return
    editor.windowConfigurationToRegister(register)
  }, "Save the current window configuration to a register.")

  editor.command("scroll-other-window", ({ editor, prefixArgument }) => {
    if (!editor.scrollOtherWindow(prefixArgument ?? 1)) editor.message("No other window to scroll")
  }, "Scroll the next window forward without selecting it.")

  editor.command("scroll-other-window-down", ({ editor, prefixArgument }) => {
    if (!editor.scrollOtherWindow(-(prefixArgument ?? 1))) editor.message("No other window to scroll")
  }, "Scroll the next window backward without selecting it.")

  editor.command("switch-to-buffer-other-window", async ({ editor, args }) => {
    const current = editor.currentBuffer.name
    const name = args[0] ?? await editor.completingRead("Switch to buffer in other window: ", {
      collection: [...editor.buffers.values()].map(b => b.name),
      history: "buffer",
      initialValue: current,
    })
    if (!name) return
    editor.displayBufferInOtherWindow(name)
    editor.message(`Switched to ${editor.currentBuffer.name} in other window`)
  }, "Switch to a buffer in another window.")

  editor.command("find-file-other-window", async ({ editor, args }) => {
    const path = args[0] ?? await editor.completingRead("Find file in other window: ", {
      completion: "file",
      history: "file",
      initialValue: editor.currentBuffer.directory() ?? process.cwd(),
    })
    if (!path) return
    editor.ensureOtherWindowSelected()
    const buffer = await editor.openFile(path)
    editor.message(`Now visiting ${buffer.name} in other window`)
  }, "Find a file in another window.")

  editor.command("display-buffer-other-window", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Display buffer in other window: ", {
      collection: [...editor.buffers.values()].map(b => b.name),
      history: "buffer",
      initialValue: editor.currentBuffer.name,
    })
    if (!name) return
    editor.displayBufferInOtherWindow(name)
    editor.message(`Displayed ${editor.currentBuffer.name} in other window`)
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

  editor.command("describe-mode", ({ buffer, editor }) => {
    const def = getMode(buffer.mode)
    const minors = editor.activeMinorModes(buffer)
    const lines = [
      `Major mode: ${buffer.mode}`,
      def?.parent ? `Parent: ${def.parent}` : "",
      minors.length ? `Minor modes: ${minors.map(mode => mode.name).join(", ")}` : "",
      `Buffer: ${buffer.name}`,
      buffer.path ? `File: ${buffer.path}` : "",
    ].filter(Boolean)
    editor.scratch("*Help*", lines.join("\n"), "text")
  }, "Describe major mode of the current buffer.")

  editor.command("describe-bindings", ({ editor }) => {
    const lines = editor.keymap.all().map(([k, v]) => `${k.padEnd(16)} ${v}`)
    editor.scratch("*Help*", lines.join("\n"), "text")
  }, "Describe key bindings of the current keymap.")

  editor.command("describe-key", async ({ editor, args }) => {
    const sequence = args.join(" ") || await editor.prompt("Describe key: ", "", "describe-key")
    if (!sequence) return
    editor.scratch("*Help*", editor.describeKey(sequence), "text")
  }, "Describe the command bound to a key sequence.")

  editor.command("minibuffer-complete", async ({ editor }) => editor.minibufferComplete(), "Complete the current minibuffer input.")
  editor.command("exit-minibuffer", ({ editor }) => editor.minibufferSubmit(), "Submit the minibuffer.")
  editor.command("abort-recursive-edit", ({ editor }) => editor.minibufferCancel(), "Abort the minibuffer or recursive edit.")

  editor.command("indent-for-tab-command", ({ editor, buffer }) => {
    if (!editor.completeAtPoint(buffer)) editor.indentLine(buffer)
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


  editor.command("proto-add-rpc", async ({ buffer, editor, args }) => {
    const name = args[0] ?? await editor.prompt("Enter the function name: ", "", "proto-rpc")
    if (!name) return
    buffer.insert(`rpc ${name}(${name}Request) returns (${name}Response);\n\nmessage ${name}Request {}\nmessage ${name}Response {}`)
  }, "Insert a protobuf RPC plus request/response messages.")

  editor.command("proto-renumber", ({ buffer, editor }) => {
    if (buffer.mark == null || buffer.mark === buffer.point) {
      editor.message("You must select a region first!")
      return
    }
    const start = Math.min(buffer.mark, buffer.point)
    const end = Math.max(buffer.mark, buffer.point)
    let counter = 1
    const replacement = buffer.text.slice(start, end).replace(/= \d+;/g, () => `= ${counter++};`)
    buffer.replaceRange(start, end, replacement)
  }, "Renumber selected protobuf fields in ascending order.")

  editor.command("dired", async ({ editor, args }) => {
    const path = args[0] ?? await editor.completingRead("Dired: ", { completion: "file", history: "file", initialValue: editor.currentBuffer.directory() ?? process.cwd() })
    if (!path) return
    await editor.openDirectory(path)
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
    if (editor.windows.length === 1) editor.nextBuffer()
  }, "Bury the current special buffer and select another buffer.")

  editor.command("delete-window", ({ editor }) => editor.deleteWindow(), "Delete the selected window.")
  editor.command("other-window", ({ editor }) => editor.nextWindow(1), "Select another window.")
  editor.command("other-window-backward", ({ editor }) => editor.nextWindow(-1), "Select the previous window in the cycle.")
  editor.command("next-window-any-frame", ({ editor }) => editor.nextWindow(1), "Select the next window.")
  editor.command("previous-window-any-frame", ({ editor }) => editor.nextWindow(-1), "Select the previous window.")
  editor.command("tab-bar-new-tab", ({ editor }) => editor.newTab(), "Create a new tab.")
  editor.command("tab-bar-close-tab", ({ editor }) => editor.closeTab(), "Close the current tab.")
  editor.command("tab-bar-switch-to-next-tab", ({ editor }) => editor.switchTab(1), "Switch to the next tab.")
  editor.command("tab-bar-switch-to-prev-tab", ({ editor }) => editor.switchTab(-1), "Switch to the previous tab.")
  editor.command("tiling-cycle", ({ editor }) => editor.message(`Layout ${editor.cycleTilingLayout()}`), "Cycle Jemacs tiling layouts.")

  editor.command("load-theme", ({ editor }) => {
    editor.setTheme(editor.theme)
    editor.message(`Loaded theme ${editor.theme.name}`)
  }, "Reload the active theme.")

  editor.command("fzf-git", async ({ editor, args }) => {
    const query = args[0] ?? ""
    const proc = Bun.spawn(["git", "ls-files"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" })
    const output = await new Response(proc.stdout).text()
    const files = output.split("\n").filter(file => file && file.includes(query))
    const choice = args[1] ?? await editor.completingRead("Git file: ", { collection: files, history: "file", initialValue: query })
    if (choice) await editor.openFile(choice)
  }, "Find a tracked Git file with completion.")

  editor.command("counsel-ag", async ({ editor, args }) => {
    const pattern = args[0] ?? await editor.prompt("Search project: ", "", "search")
    if (!pattern) return
    const proc = Bun.spawn(["rg", "--line-number", "--column", "--no-heading", pattern], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exit = await proc.exited
    const text = exit === 0 || stdout ? stdout : stderr
    editor.scratch("*grep*", text || "No matches\n", "text").kind = "grep"
  }, "Search the project with ripgrep.")

  editor.command("copy-region-to-clipboard-mac", async ({ buffer, editor }) => {
    const text = buffer.selectedText() || buffer.lineBoundsAt().text
    const pbcopy = Bun.spawn(["pbcopy"], { stdin: "pipe" })
    pbcopy.stdin.write(text)
    pbcopy.stdin.end()
    await pbcopy.exited
    killApi.pushKill(text)
    editor.message("Copied text to clipboard")
  }, "Copy region or current line to the macOS clipboard.")

  editor.command("stephen-emacs-mcp-copy-codex-config", ({ buffer, editor }) => {
    const snippet = codexMcpConfig()
    killApi.pushKill(snippet)
    buffer.insert(snippet)
    editor.message("Copied Codex MCP config for emacs-mcp to the kill ring")
  }, "Copy/insert the Codex MCP config snippet for emacs-mcp.")

  editor.command("stephen-emacs-mcp-doctor", async ({ editor }) => {
    const checks = await Promise.all(["emacsclient", "npx"].map(async command => `${command} found: ${await executable(command) ?? "no"}`))
    editor.scratch("*emacs-mcp-doctor*", [`Jemacs server running: ${editor.running ? "yes" : "no"}`, ...checks, "MCP package: @keegancsmith/emacs-mcp-server", "", "Codex MCP config snippet:", "", codexMcpConfig()].join("\n"), "text")
  }, "Display readiness checks for the external Emacs MCP server.")

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
    if (buffer.dirty) await buffer.save()
    const mod = await evaluator.loadModule(buffer.path)
    if (typeof mod.install === "function") {
      await mod.install(editor)
      editor.message(`Reloaded ${buffer.name} via install(editor)`)
      return
    }
    if (typeof mod.installDefaultConfig === "function") {
      mod.installDefaultConfig(editor)
      editor.message(`Reloaded ${buffer.name} via installDefaultConfig(editor)`)
    } else if (typeof mod.installDefaultCommands === "function") {
      mod.installDefaultCommands(editor)
      editor.message(`Reloaded ${buffer.name} via installDefaultCommands(editor)`)
      return
    }
    editor.message(`Reloaded ${buffer.name}; no installer export found`)
  }, "Save and reload the current TypeScript/JavaScript file into the live editor.")

  editor.command("save-buffers-kill-terminal", ({ editor }) => {
    editor.message("Quit requested")
    editor.quit()
  }, "Quit the editor.")

  installEmacsStandardCommands(editor, killApi)

  for (const command of ["git-link", "magit-find-main", "projectile-command-map", "ace-jump-word-mode", "ace-jump-char-mode", "yafolding-toggle-element", "gptel-menu", "gptel", "restart-emacs"]) {
    if (!editor.commands.get(command)) editor.command(command, ({ editor }) => editor.message(`${command} is a package-backed command placeholder in Jemacs.`), `${command} package placeholder.`)
  }

  return evaluator
}

async function executable(command: string): Promise<string | null> {
  const path = process.env.PATH ?? ""
  for (const dir of path.split(":")) {
    const candidate = resolve(dir, command)
    if (await access(candidate).then(() => true).catch(() => false)) return candidate
  }
  return null
}

function codexMcpConfig(): string {
  return JSON.stringify({ mcpServers: { "emacs-mcp": { command: "npx", args: ["-y", "@keegancsmith/emacs-mcp-server"] } } }, null, 2) + "\n"
}

function repeat(prefixArgument: number | null, fn: () => void): void {
  const count = Math.max(1, prefixArgument ?? 1)
  for (let i = 0; i < count; i++) fn()
}

function summarize(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.slice(0, 80))
  if (typeof value === "undefined") return "undefined"
  if (value === null) return "null"
  if (typeof value === "object") return value.constructor?.name ?? "object"
  return String(value)
}
