import { spawn as nodeSpawn } from "node:child_process"
import type { Readable } from "node:stream"
import type { BufferModel } from "../../src/kernel/buffer"
import type { CommandFn } from "../../src/kernel/command"
import type { Editor } from "../../src/kernel/editor"
import { Keymap } from "../../src/kernel/keymap"
import { defineMode, getMode, modeLineage } from "../../src/modes/mode"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"

export const COMINT_MODE = "comint-mode"
export const SHELL_MODE = "shell-mode"
export const COMINT_STATE_LOCAL = "comint-state"

export type ComintSpawnOptions = {
  cmd: string[]
  cwd?: string
  env?: Record<string, string>
  stdin?: "pipe" | "ignore"
  stdout?: "pipe" | "ignore"
  stderr?: "pipe" | "ignore"
}

export type ComintProcess = {
  pid?: number
  stdin: { write(chunk: string): void; end(): void } | null
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
  exited: Promise<number | null>
  kill(signal?: NodeJS.Signals): void
}

export type ComintDeps = {
  spawn?: (opts: ComintSpawnOptions) => ComintProcess
  shell?: string[]
  prompt?: string
  env?: Record<string, string>
}

export type ComintSession = {
  process: ComintProcess | null
  prompt: string
  promptStart: number
  inputStart: number
  history: string[]
  historyIndex: number | null
  savedInput: string
  alive: boolean
}

type ComintStartOptions = {
  name: string
  mode: string
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  prompt?: string
}

const DEFAULT_PROMPT = "$ "
const HISTORY_LIMIT = 500
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

function isPluginContext(value: unknown): value is PluginContext {
  return typeof value === "object" && value !== null
    && typeof (value as PluginContext).command === "function"
    && typeof (value as PluginContext).hook === "function"
    && typeof (value as PluginContext).onDispose === "function"
}

function mergedEnv(extra?: Record<string, string>): Record<string, string> | undefined {
  if (!extra) return undefined
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null) base[key] = value
  }
  return { ...base, ...extra }
}

function nodeReadableToWeb(stream: Readable | null): ReadableStream<Uint8Array> | null {
  if (!stream) return null
  return new ReadableStream({
    start(controller) {
      stream.on("data", chunk => {
        const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
        controller.enqueue(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
      })
      stream.on("end", () => controller.close())
      stream.on("error", err => controller.error(err))
    },
    cancel() {
      stream.destroy()
    },
  })
}

function defaultSpawnProcess(options: ComintSpawnOptions): ComintProcess {
  if (typeof Bun !== "undefined") {
    const proc = Bun.spawn({
      cmd: options.cmd,
      cwd: options.cwd,
      env: mergedEnv(options.env),
      stdin: options.stdin ?? "pipe",
      stdout: options.stdout ?? "pipe",
      stderr: options.stderr ?? "pipe",
    })
    return {
      pid: proc.pid,
      stdin: proc.stdin
        ? { write: chunk => proc.stdin!.write(chunk), end: () => proc.stdin!.end() }
        : null,
      stdout: proc.stdout ?? null,
      stderr: proc.stderr ?? null,
      exited: proc.exited.then(code => code),
      kill: signal => proc.kill(signal ?? "SIGTERM"),
    }
  }

  const proc = nodeSpawn(options.cmd[0]!, options.cmd.slice(1), {
    cwd: options.cwd,
    env: mergedEnv(options.env),
    stdio: [
      options.stdin === "ignore" ? "ignore" : "pipe",
      options.stdout === "ignore" ? "ignore" : "pipe",
      options.stderr === "ignore" ? "ignore" : "pipe",
    ],
  })
  return {
    pid: proc.pid,
    stdin: proc.stdin
      ? { write: chunk => proc.stdin!.write(chunk), end: () => proc.stdin!.end() }
      : null,
    stdout: nodeReadableToWeb(proc.stdout),
    stderr: nodeReadableToWeb(proc.stderr),
    exited: new Promise(resolve => {
      proc.on("close", code => resolve(code))
      proc.on("error", () => resolve(null))
    }),
    kill: signal => proc.kill(signal),
  }
}

function comintModeBuffer(buffer: BufferModel): boolean {
  return modeLineage(buffer.mode).some(mode => mode.name === COMINT_MODE)
}

function stateFor(buffer: BufferModel): ComintSession | null {
  return (buffer.locals.get(COMINT_STATE_LOCAL) as ComintSession | undefined) ?? null
}

function currentInput(buffer: BufferModel, state: ComintSession): string {
  return buffer.text.slice(Math.min(state.inputStart, buffer.text.length))
}

function replaceInput(buffer: BufferModel, state: ComintSession, text: string): void {
  const start = Math.min(state.inputStart, buffer.text.length)
  buffer.splice(start, buffer.text.length, text, { markDirty: false })
  buffer.point = start + text.length
}

function resetHistoryCursor(state: ComintSession): void {
  state.historyIndex = null
  state.savedInput = ""
}

function recordInput(state: ComintSession, input: string): void {
  if (!input) return
  if (state.history.at(-1) !== input) state.history.push(input)
  if (state.history.length > HISTORY_LIMIT) state.history.splice(0, state.history.length - HISTORY_LIMIT)
}

function normalizeProcessOutput(chunk: string): string {
  return chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function insertProcessOutput(editor: Editor, buffer: BufferModel, state: ComintSession, chunk: string): void {
  if (stateFor(buffer) !== state) return
  const text = normalizeProcessOutput(chunk)
  if (!text) return
  const insertAt = Math.min(state.promptStart, buffer.text.length)
  const wasAtEnd = buffer.point >= buffer.text.length
  buffer.splice(insertAt, insertAt, text, { markDirty: false, snapshot: false })
  state.promptStart += text.length
  state.inputStart += text.length
  if (wasAtEnd) buffer.point = buffer.text.length
  void editor.changed("comint-filter")
}

async function pump(stream: ReadableStream<Uint8Array> | null, onChunk: (text: string) => void): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value?.length) onChunk(decoder.decode(value, { stream: true }))
  }
  const tail = decoder.decode()
  if (tail) onChunk(tail)
}

function startPumps(editor: Editor, buffer: BufferModel, state: ComintSession): void {
  const proc = state.process
  if (!proc) return
  const onError = (err: unknown) => insertProcessOutput(editor, buffer, state, `\n[comint read error: ${(err as Error).message}]\n`)
  void pump(proc.stdout, chunk => insertProcessOutput(editor, buffer, state, chunk)).catch(onError)
  void pump(proc.stderr, chunk => insertProcessOutput(editor, buffer, state, chunk)).catch(onError)
  void proc.exited.then(code => {
    if (stateFor(buffer) !== state) return
    state.alive = false
    insertProcessOutput(editor, buffer, state, `\n[process exited ${code ?? "signal"}]\n`)
  }).catch(onError)
}

function disposeSession(buffer: BufferModel, signal: NodeJS.Signals = "SIGTERM"): void {
  const state = stateFor(buffer)
  if (!state) return
  buffer.locals.delete(COMINT_STATE_LOCAL)
  state.alive = false
  try { state.process?.kill(signal) } catch {}
}

function initializeComintBuffer(editor: Editor, buffer: BufferModel, proc: ComintProcess | null, prompt: string): BufferModel {
  buffer.setText(prompt, false, false)
  buffer.point = buffer.text.length
  buffer.dirty = false
  const state: ComintSession = {
    process: proc,
    prompt,
    promptStart: 0,
    inputStart: prompt.length,
    history: [],
    historyIndex: null,
    savedInput: "",
    alive: proc != null,
  }
  buffer.locals.set(COMINT_STATE_LOCAL, state)
  if (proc) startPumps(editor, buffer, state)
  return buffer
}

export function comintStart(editor: Editor, options: ComintStartOptions, deps: ComintDeps = {}): BufferModel {
  const existing = [...editor.buffers.values()].find(buffer => buffer.name === options.name)
  if (existing) disposeSession(existing)

  const prompt = options.prompt ?? deps.prompt ?? DEFAULT_PROMPT
  const buffer = editor.scratch(options.name, prompt, options.mode)
  if (options.cwd) buffer.locals.set("default-directory", options.cwd)

  const spawn = deps.spawn ?? defaultSpawnProcess
  let proc: ComintProcess | null = null
  try {
    proc = spawn({
      cmd: options.argv,
      cwd: options.cwd,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (err) {
    initializeComintBuffer(editor, buffer, null, prompt)
    insertProcessOutput(editor, buffer, stateFor(buffer)!, `Failed to start process: ${(err as Error).message}\n`)
    return buffer
  }

  initializeComintBuffer(editor, buffer, proc, prompt)
  return buffer
}

function shellArgv(deps: ComintDeps): string[] {
  if (deps.shell?.length) return deps.shell
  return [process.env.SHELL || "/bin/zsh", "-i"]
}

function shellEnv(deps: ComintDeps): Record<string, string> {
  return {
    TERM: "dumb",
    PS1: "",
    PROMPT: "",
    RPROMPT: "",
    ...deps.env,
  }
}

function protectComintEdit(commandName: string, inner: CommandFn, ctx: Parameters<CommandFn>[0]): unknown {
  const state = stateFor(ctx.buffer)
  if (!state || !comintModeBuffer(ctx.buffer) || ctx.editor.minibuffer) return inner(ctx)

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
  depsOrCtx: ComintDeps | PluginContext = {},
  maybeCtx?: PluginContext,
): void {
  const deps = isPluginContext(depsOrCtx) ? {} : depsOrCtx
  const ctx = maybeCtx ?? (isPluginContext(depsOrCtx) ? depsOrCtx : createPluginContext(editor))

  const comintMap = getMode(COMINT_MODE)?.keymap ?? new Keymap("comint-mode-map")
  defineMode({ name: COMINT_MODE, parent: "text", keymap: comintMap })
  defineMode({ name: SHELL_MODE, parent: COMINT_MODE })

  ctx.key("comint-mode-map", "return", "comint-send-input")
  ctx.key("comint-mode-map", "enter", "comint-send-input")
  ctx.key("comint-mode-map", "C-m", "comint-send-input")
  ctx.key("comint-mode-map", "M-p", "comint-previous-input")
  ctx.key("comint-mode-map", "M-n", "comint-next-input")
  ctx.key("comint-mode-map", "C-c C-c", "comint-interrupt-subjob")
  ctx.key("comint-mode-map", "C-c C-d", "comint-send-eof")
  ctx.key("comint-mode-map", "C-c C-u", "comint-kill-input")

  ctx.command("comint-mode", ({ editor, buffer }) => editor.enterMode(buffer, COMINT_MODE),
    "Switch the current buffer to Comint mode.")

  ctx.command("shell-mode", ({ editor, buffer }) => editor.enterMode(buffer, SHELL_MODE),
    "Switch the current buffer to Shell mode.")

  ctx.command("shell", ({ editor, buffer }) => {
    const cwd = buffer.directory() ?? process.cwd()
    comintStart(editor, {
      name: "*shell*",
      mode: SHELL_MODE,
      argv: shellArgv(deps),
      cwd,
      env: shellEnv(deps),
      prompt: deps.prompt ?? DEFAULT_PROMPT,
    }, deps)
  }, "Run an inferior shell, with I/O through the *shell* buffer.")

  ctx.command("comint-send-input", ({ buffer, editor }) => {
    const state = stateFor(buffer)
    if (!state) return editor.message("No comint process in this buffer")
    if (buffer.point < buffer.text.length) {
      buffer.point = buffer.text.length
      editor.message("Point moved to end of comint input")
      return
    }
    if (!state.process?.stdin || !state.alive) {
      editor.message("No live comint process")
      return
    }

    const input = currentInput(buffer, state)
    recordInput(state, input)
    resetHistoryCursor(state)
    try {
      state.process.stdin.write(`${input}\n`)
    } catch (err) {
      editor.message((err as Error).message)
      return
    }

    buffer.splice(buffer.text.length, buffer.text.length, `\n${state.prompt}`, { markDirty: false, snapshot: false })
    state.promptStart = buffer.text.length - state.prompt.length
    state.inputStart = buffer.text.length
    buffer.point = buffer.text.length
  }, "Send the current comint input to the subprocess.")

  ctx.command("comint-previous-input", ({ buffer, editor }) => {
    const state = stateFor(buffer)
    if (!state) return editor.message("No comint process in this buffer")
    if (!state.history.length) return editor.message("No previous input")
    if (state.historyIndex == null) {
      state.savedInput = currentInput(buffer, state)
      state.historyIndex = state.history.length - 1
    } else {
      state.historyIndex = Math.max(0, state.historyIndex - 1)
    }
    replaceInput(buffer, state, state.history[state.historyIndex] ?? "")
  }, "Cycle backward through comint input history.")

  ctx.command("comint-next-input", ({ buffer, editor }) => {
    const state = stateFor(buffer)
    if (!state) return editor.message("No comint process in this buffer")
    if (state.historyIndex == null) return editor.message("No next input")
    if (state.historyIndex < state.history.length - 1) {
      state.historyIndex++
      replaceInput(buffer, state, state.history[state.historyIndex] ?? "")
      return
    }
    replaceInput(buffer, state, state.savedInput)
    resetHistoryCursor(state)
  }, "Cycle forward through comint input history.")

  ctx.command("comint-interrupt-subjob", ({ buffer, editor }) => {
    const state = stateFor(buffer)
    if (!state?.process || !state.alive) return editor.message("No live comint process")
    state.process.kill("SIGINT")
  }, "Send SIGINT to the comint subprocess.")

  ctx.command("comint-send-eof", ({ buffer, editor }) => {
    const state = stateFor(buffer)
    if (!state?.process?.stdin || !state.alive) return editor.message("No live comint process")
    state.process.stdin.end()
  }, "Send EOF to the comint subprocess.")

  ctx.command("comint-kill-input", ({ buffer, editor }) => {
    const state = stateFor(buffer)
    if (!state) return editor.message("No comint process in this buffer")
    replaceInput(buffer, state, "")
    resetHistoryCursor(state)
  }, "Kill the current comint input line.")

  for (const command of GUARDED_EDIT_COMMANDS) {
    ctx.advice(command, { around: (inner, commandContext) => protectComintEdit(command, inner, commandContext) })
  }

  ctx.hook("kill-buffer-hook", ({ buffer }) => {
    disposeSession(buffer)
  })

  ctx.hook("kill-emacs-hook", ({ editor }) => {
    for (const buffer of editor.buffers.values()) disposeSession(buffer)
  })
}
