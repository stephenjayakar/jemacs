import { constants } from "node:fs"
import { access, readFile, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, delimiter, isAbsolute, join, resolve } from "node:path"
import type { BufferModel } from "../../src/kernel/buffer"
import type { CommandFn } from "../../src/kernel/command"
import type { Editor } from "../../src/kernel/editor"
import { Keymap } from "../../src/kernel/keymap"
import { defineMode, getMode, modeLineage } from "../../src/modes/mode"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { COMINT_MODE } from "../comint"

export const ESHELL_MODE = "eshell-mode"
export const ESHELL_STATE_LOCAL = "eshell-state"

export type EshellSpawnOptions = {
  cmd: string[]
  cwd?: string
  stdin?: "ignore"
  stdout?: "pipe" | "ignore"
  stderr?: "pipe" | "ignore"
}

export type EshellProcess = {
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
  exited: Promise<number | null>
}

export type EshellDeps = {
  spawn?: (opts: EshellSpawnOptions) => EshellProcess
  cwd?: string
}

export type EshellSession = {
  cwd: string
  prompt: string
  promptStart: number
  inputStart: number
  history: string[]
  historyIndex: number | null
  savedInput: string
  busy: boolean
}

type EvalResult = {
  clear?: boolean
  exit?: boolean
}

const HISTORY_LIMIT = 500
const CAT_MAX_BYTES = 256 * 1024
const GUARDED_EDIT_COMMANDS = [
  "self-insert-command",
  "newline",
  "newline-and-indent",
  "open-line",
  "delete-char",
  "delete-backward-char",
  "kill-line",
  "kill-word",
  "backward-kill-word",
  "kill-region",
  "clipboard-kill-region",
  "yank",
  "clipboard-yank",
  "yank-pop",
]
const INSERT_AT_END_COMMANDS = new Set(["self-insert-command", "yank", "clipboard-yank", "yank-pop"])
const BUILTINS = new Set(["cd", "pwd", "ls", "echo", "clear", "exit", "which", "cat"])

function isPluginContext(value: unknown): value is PluginContext {
  return typeof value === "object" && value !== null
    && typeof (value as PluginContext).command === "function"
    && typeof (value as PluginContext).hook === "function"
    && typeof (value as PluginContext).onDispose === "function"
}

function defaultSpawnProcess(options: EshellSpawnOptions): EshellProcess {
  const proc = Bun.spawn({
    cmd: options.cmd,
    cwd: options.cwd,
    stdin: options.stdin ?? "ignore",
    stdout: options.stdout ?? "pipe",
    stderr: options.stderr ?? "pipe",
  })
  return {
    stdout: proc.stdout ?? null,
    stderr: proc.stderr ?? null,
    exited: proc.exited.then(code => code),
  }
}

function stateFor(buffer: BufferModel): EshellSession | null {
  return (buffer.locals.get(ESHELL_STATE_LOCAL) as EshellSession | undefined) ?? null
}

function eshellModeBuffer(buffer: BufferModel): boolean {
  return modeLineage(buffer.mode).some(mode => mode.name === ESHELL_MODE)
}

function displayPath(cwd: string): string {
  const home = resolve(homedir())
  const full = resolve(cwd)
  if (full === home) return "~"
  if (full.startsWith(`${home}/`)) return `~/${full.slice(home.length + 1)}`
  return full
}

function promptFor(cwd: string): string {
  return `${displayPath(cwd)} $ `
}

function currentInput(buffer: BufferModel, state: EshellSession): string {
  return buffer.text.slice(Math.min(state.inputStart, buffer.text.length))
}

function replaceInput(buffer: BufferModel, state: EshellSession, text: string): void {
  const start = Math.min(state.inputStart, buffer.text.length)
  buffer.splice(start, buffer.text.length, text, { markDirty: false })
  buffer.point = start + text.length
}

function resetHistoryCursor(state: EshellSession): void {
  state.historyIndex = null
  state.savedInput = ""
}

function recordInput(state: EshellSession, input: string): void {
  if (!input) return
  if (state.history.at(-1) !== input) state.history.push(input)
  if (state.history.length > HISTORY_LIMIT) state.history.splice(0, state.history.length - HISTORY_LIMIT)
}

function append(buffer: BufferModel, text: string): void {
  if (!text) return
  buffer.splice(buffer.text.length, buffer.text.length, text, { markDirty: false, snapshot: false })
  buffer.point = buffer.text.length
}

function appendPrompt(buffer: BufferModel, state: EshellSession): void {
  state.prompt = promptFor(state.cwd)
  state.promptStart = buffer.text.length
  append(buffer, state.prompt)
  state.inputStart = buffer.text.length
  buffer.locals.set("default-directory", state.cwd)
}

function initializeEshellBuffer(buffer: BufferModel, cwd: string): BufferModel {
  const state: EshellSession = {
    cwd: resolve(cwd),
    prompt: "",
    promptStart: 0,
    inputStart: 0,
    history: [],
    historyIndex: null,
    savedInput: "",
    busy: false,
  }
  buffer.locals.set(ESHELL_STATE_LOCAL, state)
  buffer.locals.set("default-directory", state.cwd)
  buffer.setText("", false, false)
  appendPrompt(buffer, state)
  buffer.dirty = false
  return buffer
}

function parseCommandLine(input: string): string[] {
  const args: string[] = []
  let current = ""
  let quote: "'" | "\"" | null = null
  let escaped = false

  const push = () => {
    if (current.length) {
      args.push(current)
      current = ""
    }
  }

  for (const ch of input) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === "'" || ch === "\"") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      push()
      continue
    }
    current += ch
  }

  if (escaped) current += "\\"
  push()
  return args
}

function resolveEshellPath(path: string, cwd: string): string {
  if (!path || path === ".") return cwd
  const home = homedir()
  const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
}

async function readStreamText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value?.length) text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

async function findExecutable(command: string, cwd: string): Promise<string | null> {
  const candidates = command.includes("/")
    ? [resolveEshellPath(command, cwd)]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(dir => join(dir, command))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      const info = await stat(candidate)
      if (!info.isDirectory()) return candidate
    } catch {}
  }
  return null
}

async function runBuiltin(editor: Editor, buffer: BufferModel, state: EshellSession, name: string, args: string[]): Promise<EvalResult | null> {
  switch (name) {
    case "cd": {
      const target = resolveEshellPath(args[0] ?? "~", state.cwd)
      const info = await stat(target)
      if (!info.isDirectory()) throw new Error(`${target}: Not a directory`)
      state.cwd = target
      buffer.locals.set("default-directory", state.cwd)
      return {}
    }
    case "pwd":
      append(buffer, `${state.cwd}\n`)
      return {}
    case "ls": {
      const targets = args.length ? args : ["."]
      const chunks: string[] = []
      for (const targetArg of targets) {
        const target = resolveEshellPath(targetArg, state.cwd)
        const info = await stat(target)
        if (!info.isDirectory()) {
          chunks.push(basename(target))
          continue
        }
        const entries = await readdir(target, { withFileTypes: true })
        const names = entries
          .map(entry => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
          .sort((a, b) => a.localeCompare(b))
        const listing = names.join("\n")
        chunks.push(targets.length > 1 ? `${targetArg}:\n${listing}` : listing)
      }
      append(buffer, `${chunks.join("\n\n")}${chunks.some(Boolean) ? "\n" : ""}`)
      return {}
    }
    case "echo":
      append(buffer, `${args.join(" ")}\n`)
      return {}
    case "clear":
      return { clear: true }
    case "exit": {
      const killed = editor.killBuffer(buffer.id)
      return { exit: killed != null }
    }
    case "which": {
      const lines: string[] = []
      for (const arg of args) {
        if (BUILTINS.has(arg)) lines.push(`${arg}: eshell builtin`)
        else if (editor.commands.get(arg)) lines.push(`${arg}: Jemacs command`)
        else lines.push(await findExecutable(arg, state.cwd) ?? `${arg} not found`)
      }
      append(buffer, lines.length ? `${lines.join("\n")}\n` : "")
      return {}
    }
    case "cat": {
      const chunks: string[] = []
      for (const arg of args) {
        const target = resolveEshellPath(arg, state.cwd)
        const info = await stat(target)
        if (info.isDirectory()) {
          chunks.push(`${arg}: Is a directory\n`)
          continue
        }
        if (info.size > CAT_MAX_BYTES) {
          chunks.push(`${arg}: File is too large\n`)
          continue
        }
        chunks.push(await readFile(target, "utf8"))
      }
      append(buffer, chunks.join(""))
      return {}
    }
  }
  return null
}

async function runExternal(buffer: BufferModel, state: EshellSession, argv: string[], deps: EshellDeps): Promise<void> {
  const spawn = deps.spawn ?? defaultSpawnProcess
  const proc = spawn({
    cmd: argv,
    cwd: state.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    readStreamText(proc.stdout),
    readStreamText(proc.stderr),
  ])
  await proc.exited
  append(buffer, stdout)
  append(buffer, stderr)
}

async function evaluateInput(editor: Editor, buffer: BufferModel, state: EshellSession, input: string, deps: EshellDeps): Promise<EvalResult> {
  const argv = parseCommandLine(input.trim())
  if (!argv.length) return {}
  const [name, ...args] = argv

  try {
    const builtin = await runBuiltin(editor, buffer, state, name!, args)
    if (builtin) return builtin

    if (editor.commands.get(name!)) {
      const commandArgs = (name === "find-file" || name === "dired") && args[0]
        ? [resolveEshellPath(args[0], state.cwd), ...args.slice(1)]
        : args
      await editor.run(name!, commandArgs)
      return {}
    }

    await runExternal(buffer, state, argv, deps)
  } catch (err) {
    append(buffer, `${(err as Error).message}\n`)
  }
  return {}
}

function protectEshellEdit(commandName: string, inner: CommandFn, ctx: Parameters<CommandFn>[0]): unknown {
  const state = stateFor(ctx.buffer)
  if (!state || !eshellModeBuffer(ctx.buffer) || ctx.editor.minibuffer) return inner(ctx)

  if (ctx.buffer.markActive && ctx.buffer.mark != null && Math.min(ctx.buffer.mark, ctx.buffer.point) < state.inputStart) {
    ctx.editor.message("Prompt is read-only")
    return
  }

  if (ctx.buffer.point < state.inputStart) {
    if (INSERT_AT_END_COMMANDS.has(commandName)) {
      ctx.buffer.point = ctx.buffer.text.length
    } else {
      ctx.editor.message("Prompt is read-only")
      return
    }
  }

  if (commandName === "delete-backward-char") {
    const count = Math.max(1, Math.abs(ctx.prefixArgument ?? 1))
    const start = (ctx.prefixArgument ?? 1) < 0 ? ctx.buffer.point : ctx.buffer.point - count
    if (start < state.inputStart) {
      ctx.editor.message("Prompt is read-only")
      return
    }
  }

  return inner(ctx)
}

export function install(
  editor: Editor,
  depsOrCtx: EshellDeps | PluginContext = {},
  maybeCtx?: PluginContext,
): void {
  const deps = isPluginContext(depsOrCtx) ? {} : depsOrCtx
  const ctx = maybeCtx ?? (isPluginContext(depsOrCtx) ? depsOrCtx : createPluginContext(editor))

  const eshellMap = getMode(ESHELL_MODE)?.keymap ?? new Keymap("eshell-mode-map")
  defineMode({ name: ESHELL_MODE, parent: getMode(COMINT_MODE) ? COMINT_MODE : "text", keymap: eshellMap })

  ctx.key("eshell-mode-map", "return", "eshell-send-input")
  ctx.key("eshell-mode-map", "enter", "eshell-send-input")
  ctx.key("eshell-mode-map", "C-m", "eshell-send-input")
  ctx.key("eshell-mode-map", "M-p", "eshell-previous-input")
  ctx.key("eshell-mode-map", "M-n", "eshell-next-input")
  ctx.key("eshell-mode-map", "C-c C-u", "eshell-kill-input")

  ctx.command("eshell-mode", ({ editor, buffer }) => editor.enterMode(buffer, ESHELL_MODE),
    "Switch the current buffer to Eshell mode.")

  ctx.command("eshell", ({ editor, buffer }) => {
    const existing = [...editor.buffers.values()].find(candidate => candidate.name === "*eshell*")
    if (existing && stateFor(existing)) {
      editor.switchToBuffer(existing.id)
      return
    }

    const cwd = deps.cwd ?? (buffer.locals.get("default-directory") as string | undefined) ?? buffer.directory() ?? process.cwd()
    const eshell = editor.scratch("*eshell*", "", ESHELL_MODE)
    initializeEshellBuffer(eshell, cwd)
  }, "Start or switch to an Eshell buffer.")

  ctx.command("eshell-send-input", async ({ buffer, editor }) => {
    const state = stateFor(buffer)
    if (!state) return editor.message("No eshell session in this buffer")
    if (state.busy) return editor.message("Eshell is busy")
    if (buffer.point < buffer.text.length) {
      buffer.point = buffer.text.length
      editor.message("Point moved to end of eshell input")
      return
    }

    const input = currentInput(buffer, state)
    recordInput(state, input)
    resetHistoryCursor(state)
    append(buffer, "\n")
    state.busy = true
    try {
      const result = await evaluateInput(editor, buffer, state, input, deps)
      if (stateFor(buffer) !== state) return
      if (result.clear) buffer.setText("", false, false)
      if (result.exit) return
      appendPrompt(buffer, state)
    } finally {
      state.busy = false
    }
  }, "Send the current Eshell input to the Eshell interpreter.")

  ctx.command("eshell-previous-input", ({ buffer, editor }) => {
    const state = stateFor(buffer)
    if (!state) return editor.message("No eshell session in this buffer")
    if (!state.history.length) return editor.message("No previous input")
    if (state.historyIndex == null) {
      state.savedInput = currentInput(buffer, state)
      state.historyIndex = state.history.length - 1
    } else {
      state.historyIndex = Math.max(0, state.historyIndex - 1)
    }
    replaceInput(buffer, state, state.history[state.historyIndex] ?? "")
  }, "Cycle backward through Eshell input history.")

  ctx.command("eshell-next-input", ({ buffer, editor }) => {
    const state = stateFor(buffer)
    if (!state) return editor.message("No eshell session in this buffer")
    if (state.historyIndex == null) return editor.message("No next input")
    if (state.historyIndex < state.history.length - 1) {
      state.historyIndex++
      replaceInput(buffer, state, state.history[state.historyIndex] ?? "")
      return
    }
    replaceInput(buffer, state, state.savedInput)
    resetHistoryCursor(state)
  }, "Cycle forward through Eshell input history.")

  ctx.command("eshell-kill-input", ({ buffer, editor }) => {
    const state = stateFor(buffer)
    if (!state) return editor.message("No eshell session in this buffer")
    replaceInput(buffer, state, "")
    resetHistoryCursor(state)
  }, "Kill the current Eshell input line.")

  for (const command of GUARDED_EDIT_COMMANDS) {
    ctx.advice(command, { around: (inner, commandContext) => protectEshellEdit(command, inner, commandContext) })
  }
}
