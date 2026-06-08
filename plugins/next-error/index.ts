import { isAbsolute, resolve } from "node:path"
import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import { defineMode } from "../../src/modes/mode"
import { Keymap } from "../../src/kernel/keymap"
import { spawnProcess } from "../../src/platform/runtime"
import { findProjectRoot } from "../../src/lsp/project-root"

export type ErrorLocation = {
  file: string
  line: number
  col: number
  text: string
}

type State = {
  locations: ErrorLocation[]
  index: number
}

const states = new WeakMap<Editor, State>()

function stateFor(editor: Editor): State {
  let s = states.get(editor)
  if (!s) {
    s = { locations: [], index: -1 }
    states.set(editor, s)
  }
  return s
}

export function setLocationList(editor: Editor, locations: ErrorLocation[]): void {
  const s = stateFor(editor)
  s.locations = locations
  s.index = -1
}

export function locationList(editor: Editor): readonly ErrorLocation[] {
  return stateFor(editor).locations
}

export function locationIndex(editor: Editor): number {
  return stateFor(editor).index
}

const GREP_LINE = /^(.+?):(\d+):(?:(\d+):)?(.*)$/

export function parseGrepOutput(text: string, dir?: string): ErrorLocation[] {
  const out: ErrorLocation[] = []
  for (const line of text.split("\n")) {
    const m = GREP_LINE.exec(line)
    if (!m) continue
    const file = m[1]!
    out.push({
      file: dir && !isAbsolute(file) ? resolve(dir, file) : file,
      line: Number(m[2]),
      col: m[3] ? Number(m[3]) : 1,
      text: m[4]!,
    })
  }
  return out
}

function pointAtLineCol(text: string, line: number, col: number): number {
  const lines = text.split("\n")
  const target = Math.max(0, Math.min(line - 1, lines.length - 1))
  let offset = 0
  for (let i = 0; i < target; i++) offset += lines[i]!.length + 1
  return offset + Math.max(0, Math.min(col - 1, lines[target]?.length ?? 0))
}

async function visit(editor: Editor, loc: ErrorLocation): Promise<BufferModel> {
  const buffer = await editor.openFile(loc.file)
  buffer.point = pointAtLineCol(buffer.text, loc.line, loc.col)
  await editor.runHook("next-error-hook", buffer)
  return buffer
}

export async function grepProject(
  editor: Editor,
  options: { cwd: string; pattern?: string; prompt?: string },
): Promise<BufferModel | null> {
  const pattern = options.pattern ?? await editor.prompt(options.prompt ?? "Search project: ", "", "search")
  if (!pattern) return null
  const cwd = options.cwd
  const proc = spawnProcess({
    cmd: ["rg", "--line-number", "--column", "--no-heading", "--", pattern],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ])
  const exit = await proc.exited
  const text = exit === 0 || stdout ? stdout : stderr
  return grepBuffer(editor, text, cwd)
}

async function grepBuffer(editor: Editor, text: string, cwd: string): Promise<BufferModel> {
  const locations = parseGrepOutput(text, cwd)
  setLocationList(editor, locations)
  const buf = editor.scratch("*grep*", text || "No matches\n", "grep")
  buf.kind = "grep"
  buf.locals.set("default-directory", cwd)
  const byLine = new Map<number, ErrorLocation>()
  let li = 0, i = 0
  for (const raw of text.split("\n")) {
    li++
    if (GREP_LINE.test(raw)) byLine.set(li, locations[i++]!)
  }
  buf.locals.set("next-error-locations", byLine)
  editor.message(locations.length ? `Found ${locations.length} matches` : "No matches")
  return buf
}

async function runGrepCommand(editor: Editor, command: string, cwd: string): Promise<BufferModel> {
  const proc = spawnProcess({
    cmd: ["sh", "-c", command],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ])
  const exit = await proc.exited
  const text = exit === 0 || stdout ? stdout : stderr
  return grepBuffer(editor, text, cwd)
}

function currentDirectory(buffer: BufferModel): string {
  return buffer.directory() ?? process.cwd()
}

async function nextError(editor: Editor, n: number, reset: boolean): Promise<void> {
  const s = stateFor(editor)
  if (!s.locations.length) {
    editor.message("No buffers contain error message locations")
    return
  }
  if (reset) s.index = -1
  const target = s.index + n
  if (target >= s.locations.length) {
    editor.message("No more errors")
    return
  }
  if (target < 0) {
    editor.message("No previous error")
    return
  }
  s.index = target
  const loc = s.locations[target]!
  await visit(editor, loc)
  const label = reset ? "First" : n === 0 ? "Current" : n < 0 ? "Previous" : "Next"
  editor.message(`${label} error (${target + 1}/${s.locations.length}): ${loc.file}:${loc.line}`)
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const keymap = new Keymap("grep-map")
  keymap.bind("enter", "compile-goto-error")
  keymap.bind("return", "compile-goto-error")
  keymap.bind("C-m", "compile-goto-error")
  defineMode({ name: "grep", parent: "text", keymap })

  editor.command("next-error", ({ editor, prefixArgument }) =>
    nextError(editor, prefixArgument ?? 1, false),
  "Visit the next error or match in the location list.")

  editor.command("previous-error", ({ editor, prefixArgument }) =>
    nextError(editor, -(prefixArgument ?? 1), false),
  "Visit the previous error or match in the location list.")

  editor.command("first-error", ({ editor, prefixArgument }) =>
    nextError(editor, prefixArgument ?? 1, true),
  "Restart at the first error in the location list.")

  editor.command("compile-goto-error", async ({ editor, buffer }) => {
    const dir = (buffer.locals.get("default-directory") as string | undefined) ?? process.cwd()
    const line = buffer.lineCol().line
    // Buffers like *compilation* have header/noise lines, so buffer-line ≠ locations index;
    // producers store a Map keyed by buffer line. Array is the legacy dense (no-header) shape.
    const stored = buffer.locals.get("next-error-locations") as
      | Map<number, ErrorLocation>
      | ErrorLocation[]
      | undefined
    let loc = stored instanceof Map ? stored.get(line) : stored?.[line - 1]
    if (!loc) {
      const { text } = buffer.lineBoundsAt()
      const m = GREP_LINE.exec(text)
      if (!m) {
        editor.message("No error here")
        return
      }
      const file = m[1]!
      loc = {
        file: isAbsolute(file) ? file : resolve(dir, file),
        line: Number(m[2]),
        col: m[3] ? Number(m[3]) : 1,
        text: m[4]!,
      }
    }
    const s = stateFor(editor)
    const idx = s.locations.findIndex(l => l.file === loc.file && l.line === loc.line && l.col === loc.col)
    if (idx >= 0) s.index = idx
    await visit(editor, loc)
  }, "Visit the source for the grep/compile match at point.")

  editor.command("counsel-ag", async ({ editor, buffer, args }) => {
    const cwd = buffer.path ? await findProjectRoot(buffer.path) : process.cwd()
    await grepProject(editor, { cwd, pattern: args[0], prompt: "Search project: " })
  }, "Search the project with ripgrep and populate the location list.")

  editor.command("grep", async ({ editor, buffer, args }) => {
    const cwd = currentDirectory(buffer)
    const command = args[0] ?? await editor.prompt("Run grep (like this): ", "grep -nH -e  *", "grep-command")
    if (!command) return
    await runGrepCommand(editor, command, cwd)
  }, "Run Grep with user-specified COMMAND-ARGS.")

  editor.command("rgrep", async ({ editor, buffer, args }) => {
    const regexp = args[0] ?? await editor.prompt("Search for: ", "", "grep-regexp")
    if (!regexp) return
    const files = args[1] ?? await editor.prompt(`Search for "${regexp}" in files: `, "*", "grep-files")
    if (!files) return
    const dirInput = args[2] ?? await editor.prompt("Base directory: ", currentDirectory(buffer), "grep-dir")
    if (!dirInput) return
    const dir = resolve(dirInput)
    if (!dir) return
    const globArgs = files === "*" ? [] : ["--glob", files]
    const proc = spawnProcess({
      cmd: ["rg", "--line-number", "--column", "--no-heading", ...globArgs, "--", regexp],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
    ])
    const exit = await proc.exited
    await grepBuffer(editor, exit === 0 || stdout ? stdout : stderr, dir)
  }, "Recursively grep for REGEXP in FILES in directory tree rooted at DIR.")

  editor.key("M-g n", "next-error")
  editor.key("M-g M-n", "next-error")
  editor.key("M-g p", "previous-error")
  editor.key("M-g M-p", "previous-error")
  editor.key("C-x `", "next-error")
}
