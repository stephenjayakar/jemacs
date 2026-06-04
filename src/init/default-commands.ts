import { dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { access, appendFile, mkdir } from "node:fs/promises"
import type { CommandContext } from "../kernel/command"
import type { Editor } from "../kernel/editor"
import { diredEntryAtPoint, refreshDiredBuffer } from "../modes/dired"
import { pythonBeginningOfDefun, pythonEndOfDefun } from "../modes/python"
import { Evaluator } from "../runtime/evaluator"
import { inspectValue } from "../runtime/inspect"

export function installDefaultCommands(editor: Editor): Evaluator {
  const evaluator = new Evaluator(editor)
  let killRing = ""

  editor.command("save-buffer", async ({ buffer, editor }) => {
    await buffer.save()
    editor.message(`Saved ${buffer.path}`)
  }, "Save the current buffer to disk.")

  const findFile = async ({ editor, args }: CommandContext) => {
    const path = args[0] ?? await editor.completingRead("Find file: ", {
      collection: [],
      history: "file",
      initialValue: editor.currentBuffer.directory() ?? process.cwd(),
    })
    if (!path) return
    await editor.openFile(path)
    editor.message(`Opened ${path}`)
  }

  editor.command("open-file", findFile, "Open a file into a buffer.")
  editor.command("find-file", findFile, "Open a file into a buffer (Emacs name).")

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

  editor.command("set-mark", ({ buffer, editor }) => {
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

  editor.command("keyboard-quit", ({ buffer, editor }) => {
    editor.keymap.clearPending()
    editor.keymaps.clearPending()
    editor.prefixArgument = null
    if (editor.isearch) editor.cancelIsearch()
    if (editor.minibuffer) editor.minibufferCancel()
    buffer.deactivateMark()
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
  editor.command("forward-char", ({ buffer, prefixArgument }) => buffer.move(prefixArgument ?? 1), "Move point forward one character.")
  editor.command("backward-char", ({ buffer, prefixArgument }) => buffer.move(-(prefixArgument ?? 1)), "Move point backward one character.")
  editor.command("next-line", ({ buffer, prefixArgument }) => buffer.moveLine(prefixArgument ?? 1), "Move point down one line.")
  editor.command("previous-line", ({ buffer, prefixArgument }) => buffer.moveLine(-(prefixArgument ?? 1)), "Move point up one line.")
  editor.command("beginning-of-line", ({ buffer }) => buffer.moveToLineStart(), "Move point to the beginning of the line.")
  editor.command("end-of-line", ({ buffer }) => buffer.moveToLineEnd(), "Move point to the end of the line.")
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
    killRing = killed
  }, "Kill the word before point.")
  editor.command("kill-line", ({ buffer }) => {
    const lineEnd = buffer.text.indexOf("\n", buffer.point)
    const end = lineEnd === -1 ? buffer.text.length : lineEnd + (lineEnd === buffer.point ? 1 : 0)
    killRing = buffer.deleteRange(buffer.point, end)
  }, "Kill text from point to end of line.")
  editor.command("kill-region", ({ buffer }) => {
    if (buffer.mark == null || buffer.mark === buffer.point) {
      const line = buffer.lineBoundsAt()
      const end = line.end < buffer.text.length ? line.end + 1 : line.end
      killRing = buffer.deleteRange(line.start, end)
      return
    }
    killRing = buffer.deleteRange(buffer.mark, buffer.point)
    buffer.clearMark()
  }, "Kill the active region, or the current line when no region is active.")
  editor.command("copy-region", ({ buffer, editor }) => {
    const selected = buffer.selectedText() || buffer.lineBoundsAt().text + (buffer.lineBoundsAt().end < buffer.text.length ? "\n" : "")
    killRing = selected
    editor.message(buffer.selectedText() ? "Copied region" : "Copied line")
  }, "Copy the active region, or the current line when no region is active.")
  editor.command("yank", ({ buffer }) => buffer.insert(killRing), "Insert the last killed text at point.")

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
    editor.registers.set(register, buffer.point)
    editor.message(`Saved point ${buffer.point} to register ${register}`)
  }, "Save point to a register.")

  editor.command("jump-to-register", async ({ buffer, editor, args }) => {
    const register = args[0] ?? await editor.prompt("Jump to register: ", "f", "register")
    if (!register) return
    const point = editor.registers.get(register)
    if (point == null) {
      editor.message(`Register ${register} is empty`)
      return
    }
    buffer.point = Math.max(0, Math.min(point, buffer.text.length))
  }, "Jump to a saved point register.")

  editor.command("replace-string", async ({ buffer, editor, args }) => {
    const from = args[0] ?? await editor.prompt("Replace string: ", "", "replace")
    if (!from) return
    const to = args[1] ?? await editor.prompt(`Replace ${from} with: `, "", "replace")
    if (to == null) return
    const region = buffer.mark == null || buffer.mark === buffer.point ? { start: 0, end: buffer.text.length } : { start: Math.min(buffer.mark, buffer.point), end: Math.max(buffer.mark, buffer.point) }
    const replaced = buffer.text.slice(region.start, region.end).split(from).join(to)
    buffer.replaceRange(region.start, region.end, replaced)
  }, "Replace a string in the region or current buffer.")

  editor.command("eval-selection", async ({ buffer, editor }) => {
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

  editor.command("run-command", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("M-x ", { collection: editor.commands.names(), history: "command" })
    if (!name) return
    const rest = args.length > 1 ? args.slice(1) : []
    await editor.run(name, rest)
  }, "Prompt for and run a command.")

  editor.command("inspect-editor", ({ editor }) => {
    editor.scratch("*editor-inspector*", inspectValue(editor, 4), "text")
  }, "Inspect the live editor object.")

  editor.command("inspect-commands", ({ editor }) => {
    const lines = editor.commands.entries().map(c => `${c.name.padEnd(24)} ${c.description ?? ""}`)
    editor.scratch("*commands*", lines.join("\n"), "text")
  }, "List registered commands.")

  editor.command("inspect-keymap", ({ editor }) => {
    const lines = editor.keymap.all().map(([k, v]) => `${k.padEnd(16)} ${v}`)
    editor.scratch("*keymap*", lines.join("\n"), "text")
  }, "List keybindings.")

  editor.command("describe-key", async ({ editor, args }) => {
    const sequence = args.join(" ") || await editor.prompt("Describe key: ", "", "describe-key")
    if (!sequence) return
    editor.scratch("*Help*", editor.describeKey(sequence), "text")
  }, "Describe the command bound to a key sequence.")

  editor.command("minibuffer-complete", ({ editor }) => editor.minibufferComplete(), "Complete the current minibuffer input.")
  editor.command("minibuffer-submit", ({ editor }) => editor.minibufferSubmit(), "Submit the minibuffer.")
  editor.command("minibuffer-cancel", ({ editor }) => editor.minibufferCancel(), "Cancel the minibuffer.")
  editor.command("minibuffer-backspace", ({ editor }) => editor.minibufferBackspace(), "Delete one character in the minibuffer.")

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
    const path = args[0] ?? await editor.completingRead("Dired: ", { collection: [], history: "file", initialValue: editor.currentBuffer.directory() ?? process.cwd() })
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
  editor.command("quit-window", ({ editor }) => {
    editor.deleteWindow()
    if (editor.windows.length === 1) editor.nextBuffer()
  }, "Bury the current special buffer and select another buffer.")

  editor.command("split-window", ({ editor }) => editor.splitWindow(), "Split the selected window.")
  editor.command("delete-window", ({ editor }) => editor.deleteWindow(), "Delete the selected window.")
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
    killRing = text
    editor.message("Copied text to clipboard")
  }, "Copy region or current line to the macOS clipboard.")

  editor.command("stephen-emacs-mcp-copy-codex-config", ({ buffer, editor }) => {
    const snippet = codexMcpConfig()
    killRing = snippet
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
    const path = args[0] ?? await editor.prompt("Load plugin: ", "plugins/demo-plugin.ts", "file")
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
    if (typeof mod.installDefaultCommands === "function") {
      mod.installDefaultCommands(editor)
      editor.message(`Reloaded ${buffer.name} via installDefaultCommands(editor)`)
      return
    }
    editor.message(`Reloaded ${buffer.name}; no installer export found`)
  }, "Save and reload the current TypeScript/JavaScript file into the live editor.")

  editor.command("show-messages", ({ editor }) => editor.switchToBuffer("*messages*"), "Switch to the messages buffer.")

  editor.command("quit", ({ editor }) => {
    editor.message("Quit requested")
    editor.quit()
  }, "Quit the editor.")

  editor.key("C-x C-x", "exchange-point-and-mark")
  editor.key("C-x C-s", "save-buffer")
  editor.key("C-x C-f", "open-file")
  editor.key("C-x b", "switch-to-buffer")
  editor.key("C-x C-b", "list-buffers")
  editor.key("C-x C-e", "eval-selection")
  editor.key("C-x C-c", "quit")
  editor.key("C-x C-j", "previous-buffer")
  editor.key("C-x C-l", "next-buffer")
  editor.key("C-x l", "goto-line")
  editor.key("C-x C-r", "revert-buffer")
  editor.key("C-x f", "fzf-git")
  editor.key("C-x o", "next-window-any-frame")
  editor.key("C-space", "set-mark")
  editor.key("C-u", "universal-argument")
  editor.key("C-g", "keyboard-quit")
  editor.key("C-s", "isearch-forward")
  editor.key("C-r", "isearch-backward")
  editor.key("C-f", "forward-char")
  editor.key("C-b", "backward-char")
  editor.key("C-n", "next-line")
  editor.key("C-p", "previous-line")
  editor.key("C-a", "beginning-of-line")
  editor.key("C-e", "end-of-line")
  editor.key("M-f", "forward-word")
  editor.key("M-b", "backward-word")
  editor.key("M-backspace", "backward-kill-word")
  editor.key("M-h", "backward-kill-word")
  editor.key("esc f", "forward-word")
  editor.key("esc b", "backward-word")
  editor.key("esc backspace", "backward-kill-word")
  editor.key("C-m", "newline")
  editor.key("C-j", "newline-and-indent")
  editor.key("tab", "indent-for-tab-command")
  editor.key("C-i", "indent-for-tab-command")
  editor.key("C-d", "delete-char")
  editor.key("C-k", "kill-line")
  editor.key("C-w", "kill-region")
  editor.key("M-w", "copy-region")
  editor.key("C-y", "yank")
  editor.key("C-_", "undo")
  editor.key("M-x", "run-command")
  editor.key("esc x", "run-command")
  editor.key("C-h e", "inspect-editor")
  editor.key("C-h c", "inspect-commands")
  editor.key("C-h k", "describe-key")
  editor.key("C-x d", "dired")
  editor.key("C-c r", "replace-string")
  editor.key("C-c d", "point-to-register")
  editor.key("C-c C-d", "jump-to-register")
  editor.key("C-c g l", "git-link")
  editor.key("C-c g m", "magit-find-main")
  editor.key("C-c p", "projectile-command-map")
  editor.key("C-c SPC", "ace-jump-word-mode")
  editor.key("C-c C-x SPC", "ace-jump-char-mode")
  editor.key("C-c RET", "yafolding-toggle-element")
  editor.key("C-c t", "lsp-find-definition")
  editor.key("C-c C-t", "lsp-ui-peek-find-implementation")
  editor.key("C-x C-a", "lsp-execute-code-action")
  editor.key("C-\\", "tiling-cycle")
  editor.key("C-tab", "next-window-any-frame")
  editor.key("C-S-tab", "previous-window-any-frame")
  editor.key("C-M-tab", "tab-bar-switch-to-next-tab")
  editor.key("C-M-S-tab", "tab-bar-switch-to-prev-tab")
  editor.key("s-}", "tab-bar-switch-to-next-tab")
  editor.key("s-{", "tab-bar-switch-to-prev-tab")
  editor.key("s-t", "tab-bar-new-tab")
  editor.key("s-w", "tab-bar-close-tab")
  editor.key("s-f", "counsel-ag")
  editor.key("s-m", "gptel-menu")
  editor.key("s-g", "gptel")
  editor.key("s-r", "restart-emacs")
  editor.key("C-c C-l", "load-plugin")
  editor.key("C-c C-r", "reload-current-file")
  editor.key("C-c C-q", "quit")
  editor.defineKey("minibuffer", "tab", "minibuffer-complete")
  editor.defineKey("minibuffer", "C-i", "minibuffer-complete")
  editor.defineKey("minibuffer", "enter", "minibuffer-submit")
  editor.defineKey("minibuffer", "C-m", "minibuffer-submit")
  editor.defineKey("minibuffer", "esc", "minibuffer-cancel")
  editor.defineKey("minibuffer", "backspace", "minibuffer-backspace")

  for (const command of ["git-link", "magit-find-main", "projectile-command-map", "ace-jump-word-mode", "ace-jump-char-mode", "yafolding-toggle-element", "lsp-find-definition", "lsp-ui-peek-find-implementation", "lsp-execute-code-action", "gptel-menu", "gptel", "restart-emacs"]) {
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
