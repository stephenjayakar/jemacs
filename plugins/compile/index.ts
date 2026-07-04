import { isAbsolute, resolve } from "node:path"
import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import { defineMode } from "../../src/modes/mode"
import { Keymap } from "../../src/kernel/keymap"
import { spawnProcess, type SpawnHandle, type SpawnOptions } from "../../src/platform/runtime"
import { findProjectRoot } from "../../src/lsp/project-root"
import { setLocationList, type ErrorLocation } from "../next-error"

export type CompilationSeverity = NonNullable<ErrorLocation["severity"]>

type SeveritySpec =
  | CompilationSeverity
  | {
    group: number
    map?: Record<string, CompilationSeverity>
    default?: CompilationSeverity
  }

export type CompileDeps = {
  spawn?: (opts: SpawnOptions) => SpawnHandle
  projectRoot?: (filePath: string) => Promise<string>
  shell?: string[]
}

export type ErrorRegexp = {
  name: string
  re: RegExp
  file: number
  line: number
  col?: number
  severity?: SeveritySpec
}

/** Subset of Emacs `compilation-error-regexp-alist-alist`, ordered specific → general. */
export const compilationErrorRegexpAlist: ErrorRegexp[] = [
  { name: "gcc-include", re: /^\s*(?:In file included from|from)\s+(.+?):(\d+)(?::(\d+))?[,:]/, file: 1, line: 2, col: 3, severity: "info" },
  { name: "rustc", re: /^\s*-->\s+(.+?):(\d+):(\d+)/, file: 1, line: 2, col: 3, severity: "info" },
  { name: "cargo-test-panic", re: /^\s*(?:thread '[^']+' )?panicked at (.+?):(\d+):(\d+):/, file: 1, line: 2, col: 3, severity: "error" },
  { name: "java-maven", re: /^\s*\[(ERROR|WARNING|INFO)\]\s+((?:[A-Za-z]:)?[^:\n]+?\.java):\[(\d+),(\d+)\]/i, file: 2, line: 3, col: 4, severity: { group: 1 } },
  { name: "java", re: /^\s*((?:[A-Za-z]:)?[^\s:\n]+?\.java):(\d+):\s*(error|warning)\b/i, file: 1, line: 2, severity: { group: 3 } },
  { name: "tsc", re: /^\s*((?:[A-Za-z]:)?[^\s(\n][^(\n]*?\.[cm]?[tj]sx?)\((\d+),(\d+)\):\s*(error|warning|info)\b/i, file: 1, line: 2, col: 3, severity: { group: 4 } },
  { name: "msft", re: /^\s*(?:\d+>)?((?:[A-Za-z]:)?[^\s(][^(\n]*?)\((\d+)(?:,(\d+))?\)\s*:\s*(error|warning)?/i, file: 1, line: 2, col: 3, severity: { group: 4 } },
  { name: "python-tracebacks", re: /^\s*File "([^"]+)", lines? (\d+)/, file: 1, line: 2, severity: "error" },
  { name: "node-stack", re: /^\s*at\s+(?:.+?\s+)?\((.+):(\d+):(\d+)\)\s*$/, file: 1, line: 2, col: 3, severity: "error" },
  { name: "node-stack-bare", re: /^\s*at\s+(.+):(\d+):(\d+)\s*$/, file: 1, line: 2, col: 3, severity: "error" },
  { name: "go", re: /^\s*((?:[A-Za-z]:)?(?:\.{1,2}\/|\/)?[^\s:\n]+?\.go):(\d+):(\d+):/, file: 1, line: 2, col: 3, severity: "error" },
  // The (?!\d+:) guard keeps pure-digit "files" (timestamps like 12:34:56) from matching.
  { name: "gnu", re: /^(?!\d+:)((?:[A-Za-z]:)?[^\s:][^:\n]*?):(\d+)(?:[.:](\d+))?:\s*(?:(error|warning|note|info)\b)?/i, file: 1, line: 2, col: 3, severity: { group: 4, map: { note: "info" } } },
]

const ANSI_RE = /(?:\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]|\x1B[@-Z\\-_]|\x9B[0-?]*[ -/]*[@-~])/g
const COMPLETE_ANSI_RE = /^(?:\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]|\x1B[@-Z\\-_]|\x9B[0-?]*[ -/]*[@-~])/

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}

function trailingIncompleteAnsiStart(text: string): number {
  const esc = text.lastIndexOf("\x1b")
  const csi = text.lastIndexOf("\x9b")
  const start = Math.max(esc, csi)
  if (start < 0) return -1
  const tail = text.slice(start)
  return COMPLETE_ANSI_RE.test(tail) ? -1 : start
}

function createAnsiStripper(): { write(chunk: string): string; flush(): string } {
  let pending = ""
  return {
    write(chunk: string): string {
      const text = pending + chunk
      const pendingStart = trailingIncompleteAnsiStart(text)
      pending = pendingStart >= 0 ? text.slice(pendingStart) : ""
      return stripAnsi(pendingStart >= 0 ? text.slice(0, pendingStart) : text)
    },
    flush(): string {
      pending = ""
      return ""
    },
  }
}

function severityFor(pat: ErrorRegexp, m: RegExpExecArray): CompilationSeverity | undefined {
  const spec = pat.severity
  if (!spec) return undefined
  if (typeof spec === "string") return spec
  const raw = m[spec.group]?.toLowerCase()
  if (!raw) return spec.default
  return spec.map?.[raw] ?? (raw === "warning" ? "warning" : raw === "info" ? "info" : "error")
}

function parseCompilationLines(text: string, cwd: string): Array<{ lineNumber: number; location: ErrorLocation }> {
  const out: Array<{ lineNumber: number; location: ErrorLocation }> = []
  let lineNumber = 0
  for (const raw of stripAnsi(text).split("\n")) {
    lineNumber++
    const lineText = raw.trim()
    if (!lineText) continue
    for (const pat of compilationErrorRegexpAlist) {
      const m = pat.re.exec(raw)
      if (!m) continue
      const file = m[pat.file]
      const line = Number(m[pat.line])
      if (!file || !Number.isFinite(line)) break
      const col = pat.col != null && m[pat.col] ? Number(m[pat.col]) : 1
      if (!Number.isFinite(col)) break
      const abs = isAbsolute(file) ? file : resolve(cwd, file)
      const severity = severityFor(pat, m)
      out.push({
        lineNumber,
        location: {
          file: abs,
          line,
          col,
          text: lineText,
          ...(severity ? { severity } : {}),
        },
      })
      break
    }
  }
  return out
}

export function parseCompilationOutput(text: string, cwd: string): ErrorLocation[] {
  return parseCompilationLines(text, cwd).map(entry => entry.location)
}

type State = {
  command: string
  directory: string
  proc: SpawnHandle | null
}

const states = new WeakMap<Editor, State>()

function stateFor(editor: Editor): State {
  let s = states.get(editor)
  if (!s) {
    s = { command: "make -k ", directory: process.cwd(), proc: null }
    states.set(editor, s)
  }
  return s
}

export function lastCompileCommand(editor: Editor): string {
  return stateFor(editor).command
}

export function lastCompileDirectory(editor: Editor): string {
  return stateFor(editor).directory
}

function append(editor: Editor, buf: BufferModel, chunk: string): void {
  const atEnd = buf.point >= buf.text.length
  buf.append(chunk)
  if (atEnd) buf.point = buf.text.length
  void editor.changed("compilation-filter")
}

async function pump(stream: ReadableStream<Uint8Array> | null, onChunk: (s: string) => void): Promise<void> {
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

export async function compilationStart(
  editor: Editor,
  command: string,
  cwd: string,
  deps: CompileDeps = {},
): Promise<BufferModel> {
  const s = stateFor(editor)
  if (s.proc) {
    s.proc.kill()
    s.proc = null
  }
  s.command = command
  s.directory = cwd

  const header =
    `-*- mode: compilation; default-directory: ${JSON.stringify(cwd)} -*-\n` +
    `Compilation started at ${new Date().toString()}\n\n` +
    `${command}\n`
  const buf = editor.scratch("*compilation*", header, "compilation")
  buf.readOnly = true
  buf.locals.set("default-directory", cwd)
  buf.locals.set("compile-command", command)
  setLocationList(editor, [])

  const spawn = deps.spawn ?? spawnProcess
  const shell = deps.shell ?? ["sh", "-c"]
  let proc: SpawnHandle
  try {
    proc = spawn({ cmd: [...shell, command], cwd, stdout: "pipe", stderr: "pipe" })
  } catch (err) {
    append(editor, buf, `\nCompilation failed to start: ${(err as Error).message}\n`)
    return buf
  }
  s.proc = proc

  let output = ""
  const onChunk = (chunk: string) => {
    if (!chunk) return
    output += chunk
    append(editor, buf, chunk)
  }
  const stdoutStripper = createAnsiStripper()
  const stderrStripper = createAnsiStripper()
  await Promise.all([
    pump(proc.stdout, chunk => onChunk(stdoutStripper.write(chunk))),
    pump(proc.stderr, chunk => onChunk(stderrStripper.write(chunk))),
  ])
  onChunk(stdoutStripper.flush())
  onChunk(stderrStripper.flush())
  const code = await proc.exited
  s.proc = null

  const parsed = parseCompilationLines(output, cwd)
  const locations = parsed.map(entry => entry.location)
  setLocationList(editor, locations)
  const byLine = new Map<number, ErrorLocation>()
  const outputStartLine = header.split("\n").length
  for (const entry of parsed) byLine.set(outputStartLine + entry.lineNumber - 1, entry.location)
  buf.locals.set("next-error-locations", byLine)

  const status = code === 0
    ? "Compilation finished"
    : `Compilation exited abnormally with code ${code ?? "?"}`
  append(editor, buf, `\n${status} at ${new Date().toString()}\n`)
  editor.message(locations.length
    ? `${status} (${locations.length} error${locations.length === 1 ? "" : "s"})`
    : status)
  await editor.runHook("compilation-finish-hook", buf)
  return buf
}

// `deps` stays positional-2 so tests can inject spawn/projectRoot; builtin.ts
// passes a PluginContext there, which satisfies CompileDeps (all-optional) and
// is ignored — compile registers no hooks/advice/timers needing disposal.
export function install(editor: Editor, deps: CompileDeps = {}, ctx: PluginContext = createPluginContext(editor)): void {
  void ctx
  const projectRoot = deps.projectRoot ?? findProjectRoot

  const keymap = new Keymap("compilation-map")
  keymap.bind("g", "recompile")
  keymap.bind("enter", "compile-goto-error")
  keymap.bind("return", "compile-goto-error")
  keymap.bind("C-m", "compile-goto-error")
  keymap.bind("C-c C-k", "kill-compilation")
  defineMode({ name: "compilation", parent: "text", keymap })

  const rootFor = async (buffer: BufferModel): Promise<string> =>
    buffer.path ? projectRoot(buffer.path) : buffer.directory() ?? process.cwd()

  editor.command("compile", async ({ editor, buffer, args }) => {
    const s = stateFor(editor)
    const command = args[0] ?? await editor.prompt("Compile command: ", s.command, "compile-command")
    if (command == null) return
    const cwd = buffer.mode === "compilation" ? s.directory : await rootFor(buffer)
    await compilationStart(editor, command, cwd, deps)
  }, "Run a shell command and collect output in *compilation*, parsing error locations.")

  editor.command("recompile", async ({ editor }) => {
    const s = stateFor(editor)
    await compilationStart(editor, s.command, s.directory, deps)
  }, "Re-run the last compilation command in its original directory.")

  editor.command("kill-compilation", ({ editor }) => {
    const s = stateFor(editor)
    if (!s.proc) {
      editor.message("No compilation process running")
      return
    }
    s.proc.kill()
    s.proc = null
    editor.message("Compilation killed")
  }, "Kill the running compilation process.")
}
