import type { BufferModel } from "../kernel/buffer"
import type { Editor } from "../kernel/editor"
import { defcustom, getCustom } from "../runtime/custom"
import { sessionFor as jtermSessionFor, sessions as jtermSessions, spawnSession, type JTermSession } from "../../plugins/jterm"
import { pythonCurrentDefunRange } from "./python"

const PYTHON_BUFFER_NAME = "*Python*"

export type PythonShellSession = {
  alive?: boolean
  writeRaw(bytes: string): void
}

export type PythonShellFactory = (
  editor: Editor,
  buffer: BufferModel,
  argv: string[],
  opts: { cwd?: string; rows: number; cols: number; label: string },
) => Promise<PythonShellSession>

type PythonShellState = {
  buffer: BufferModel
  session: PythonShellSession
}

const states = new WeakMap<Editor, PythonShellState>()

defcustom("python-shell-interpreter", "string", "python3", "Python interpreter used by run-python.")

export function installPythonShellCommands(editor: Editor, factory: PythonShellFactory = spawnPythonJtermSession): void {
  editor.command("run-python", async ({ editor }) => {
    await ensurePythonShell(editor, factory, true)
  }, "Run an inferior Python process.")

  editor.command("python-shell-send-region", async ({ buffer, editor }) => {
    if (!buffer.useRegion()) {
      editor.message("No region selected")
      return
    }
    await sendPythonText(editor, factory, buffer.selectedText())
  }, "Send the region to the inferior Python process.")

  editor.command("python-shell-send-buffer", async ({ buffer, editor }) => {
    await sendPythonText(editor, factory, buffer.text)
  }, "Send the buffer to the inferior Python process.")

  editor.command("python-shell-send-defun", async ({ buffer, editor }) => {
    const { start, end } = pythonCurrentDefunRange(buffer)
    await sendPythonText(editor, factory, buffer.text.slice(start, end))
  }, "Send the current defun to the inferior Python process.")

  editor.command("python-shell-switch-to-shell", async ({ editor }) => {
    const { buffer } = await ensurePythonShell(editor, factory, false)
    editor.displayBufferInOtherWindow(buffer.id, { select: true })
  }, "Switch to the inferior Python process buffer in another window.")
}

export function preparePythonShellInput(text: string): string {
  const source = text.endsWith("\n") ? text : `${text}\n`
  if (!source.trimEnd().includes("\n")) return source
  return `exec(compile(${JSON.stringify(source)}, "<jemacs-python>", "exec"))\n`
}

async function sendPythonText(editor: Editor, factory: PythonShellFactory, text: string): Promise<void> {
  const { session } = await ensurePythonShell(editor, factory, false)
  session.writeRaw(preparePythonShellInput(text))
  editor.message("Sent to Python")
}

async function ensurePythonShell(editor: Editor, factory: PythonShellFactory, select: boolean): Promise<PythonShellState> {
  const existing = states.get(editor)
  if (existing && editor.buffers.has(existing.buffer.id) && isSessionAlive(existing.session)) {
    if (select) editor.switchToBuffer(existing.buffer.id)
    return existing
  }

  const previous = editor.currentBufferId
  const previousBuffer = editor.currentBuffer
  const buffer = editor.scratch(PYTHON_BUFFER_NAME, "", "jterm-mode")
  buffer.readOnly = true
  const session = await factory(editor, buffer, [pythonInterpreter(), "-i"], {
    cwd: previousBuffer.directory?.(),
    rows: bodyRows(buffer),
    cols: bodyCols(buffer),
    label: "python",
  })
  const state = { buffer, session }
  states.set(editor, state)

  if (editor.commands.get("jterm-char-mode")) await editor.run("jterm-char-mode")
  if (!select && editor.buffers.has(previous)) editor.switchToBuffer(previous)
  else editor.switchToBuffer(buffer.id)
  return state
}

function pythonInterpreter(): string {
  return getCustom<string>("python-shell-interpreter") ?? "python3"
}

function isSessionAlive(session: PythonShellSession): boolean {
  return session.alive !== false
}

function bodyRows(buffer: BufferModel): number {
  return Math.max(1, (buffer.locals.get("window-body-rows") as number | undefined) ?? 30)
}

function bodyCols(buffer: BufferModel): number {
  return Math.max(1, (buffer.locals.get("window-body-cols") as number | undefined) ?? 100)
}

async function spawnPythonJtermSession(editor: Editor, buffer: BufferModel, argv: string[], opts: { cwd?: string; rows: number; cols: number; label: string }): Promise<JTermSession> {
  const session = await spawnSession(editor, buffer, argv, opts)
  jtermSessions.set(buffer, session)
  return session
}

export function pythonShellSessionFor(buffer: BufferModel): PythonShellSession | undefined {
  return jtermSessionFor(buffer)
}
