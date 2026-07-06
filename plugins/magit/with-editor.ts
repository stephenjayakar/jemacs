import { basename, join } from "node:path"
import { tmpdir } from "node:os"
import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import { chmod, mkdir, readFileText, readdir, rm, unlink, writeFileText } from "../../src/platform/runtime"
import type { FontLockRange, TextSpan } from "../../src/modes/mode"

export const WITH_EDITOR_REQUEST_LOCAL = "magit-with-editor-request"
export const WITH_EDITOR_PROCESS_LOCAL = "magit-with-editor-process"
export const WITH_EDITOR_AWAIT_ON_FINISH_LOCAL = "magit-with-editor-await-on-finish"

export type WithEditorRequest = {
  id: string
  filePath: string
  replyPath: string
}

export type WithEditorSession = {
  dir: string
  helperPath: string
  env: Record<string, string>
  firstRequest: Promise<WithEditorRequest>
  dispose(): Promise<void>
}

export type WithEditorSessionOptions = {
  onRequest(request: WithEditorRequest): void | Promise<void>
  timeoutMs?: number
}

export async function createWithEditorSession(options: WithEditorSessionOptions): Promise<WithEditorSession> {
  const dir = join(tmpdir(), `jemacs-with-editor-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  const helperPath = join(dir, "jemacs-with-editor")
  await writeFileText(helperPath, helperScript(dir, options.timeoutMs ?? 10 * 60 * 1000))
  await chmod(helperPath, 0o700)

  let disposed = false
  const seen = new Set<string>()
  let firstResolve!: (request: WithEditorRequest) => void
  let firstReject!: (error: Error) => void
  const firstRequest = new Promise<WithEditorRequest>((resolve, reject) => {
    firstResolve = resolve
    firstReject = reject
  })
  let firstPending = true

  const poll = async () => {
    if (disposed) return
    let files: string[]
    try {
      files = await readdir(dir)
    } catch (error) {
      if (disposed) return
      firstReject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    for (const file of files) {
      if (!file.startsWith("request-") || file.endsWith(".tmp") || file.endsWith(".reply") || seen.has(file)) continue
      seen.add(file)
      const requestPath = join(dir, file)
      try {
        const text = await readFileText(requestPath)
        await unlink(requestPath).catch(() => {})
        const [filePath, replyPath] = text.split("\n")
        if (!filePath || !replyPath) continue
        const request: WithEditorRequest = { id: file, filePath, replyPath }
        if (firstPending) {
          firstPending = false
          firstResolve(request)
        }
        await options.onRequest(request)
      } catch (error) {
        if (firstPending) {
          firstPending = false
          firstReject(error instanceof Error ? error : new Error(String(error)))
        }
      }
    }
  }

  const timer = setInterval(() => { void poll() }, 25)
  void poll()

  return {
    dir,
    helperPath,
    env: {
      GIT_EDITOR: helperPath,
      GIT_SEQUENCE_EDITOR: helperPath,
    },
    firstRequest,
    async dispose() {
      if (disposed) return
      disposed = true
      clearInterval(timer)
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

export async function openWithEditorBuffer(
  editor: Editor,
  request: WithEditorRequest,
  options: { root: string; winconf?: ReturnType<Editor["currentWindowConfiguration"]>; awaitOnFinish?: boolean } ,
): Promise<BufferModel> {
  const text = await readFileText(request.filePath)
  const rebaseTodo = isRebaseTodoPath(request.filePath)
  const name = rebaseTodo ? "*git-rebase-todo*" : "*COMMIT_EDITMSG*"
  const mode = rebaseTodo ? "git-rebase-mode" : "magit-commit"
  const buffer = editor.scratch(name, text, mode)
  buffer.readOnly = false
  buffer.path = request.filePath
  buffer.locals.set("magit-root", options.root)
  buffer.locals.set("magit-winconf", options.winconf)
  buffer.locals.set("comment-start", "#")
  buffer.locals.set(WITH_EDITOR_REQUEST_LOCAL, request)
  buffer.locals.set(WITH_EDITOR_AWAIT_ON_FINISH_LOCAL, options.awaitOnFinish ?? !rebaseTodo)
  buffer.point = firstEditablePoint(text)
  return buffer
}

export function isWithEditorBuffer(buffer: BufferModel): boolean {
  return !!buffer.locals.get(WITH_EDITOR_REQUEST_LOCAL)
}

export function withEditorRequest(buffer: BufferModel): WithEditorRequest | null {
  return (buffer.locals.get(WITH_EDITOR_REQUEST_LOCAL) as WithEditorRequest | undefined) ?? null
}

export async function acceptWithEditorBuffer(buffer: BufferModel): Promise<boolean> {
  const request = withEditorRequest(buffer)
  if (!request) return false
  await writeFileText(request.filePath, buffer.text)
  await writeEditorReply(request, "ok")
  buffer.locals.delete(WITH_EDITOR_REQUEST_LOCAL)
  return true
}

export async function abortWithEditorBuffer(buffer: BufferModel): Promise<boolean> {
  const request = withEditorRequest(buffer)
  if (!request) return false
  await writeEditorReply(request, "abort")
  buffer.locals.delete(WITH_EDITOR_REQUEST_LOCAL)
  return true
}

export function gitCommitMessageBody(text: string): string {
  return text
    .split("\n")
    .filter(line => !line.trimStart().startsWith("#"))
    .join("\n")
    .trim()
}

export function gitCommitFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  let lineStart = offset
  let sawSummary = buffer.text.slice(0, offset).split("\n").some(line => line.trim() && !line.trimStart().startsWith("#"))
  for (const line of text.split("\n")) {
    const lineEnd = lineStart + line.length
    if (line.trimStart().startsWith("#")) {
      spans.push({ start: lineStart, end: lineEnd, face: "comment" })
    } else if (!sawSummary && line.trim()) {
      sawSummary = true
      if (line.length > 50) spans.push({ start: lineStart + 50, end: lineEnd, face: "warning" })
    }
    lineStart = lineEnd + 1
  }
  return spans
}

export function withEditorHelperScript(sessionDir: string, timeoutMs = 10 * 60 * 1000): string {
  return helperScript(sessionDir, timeoutMs)
}

async function writeEditorReply(request: WithEditorRequest, status: "ok" | "abort"): Promise<void> {
  await writeFileText(request.replyPath, `${status}\n`)
}

function isRebaseTodoPath(path: string): boolean {
  return basename(path) === "git-rebase-todo" || path.includes("/rebase-merge/git-rebase-todo") || path.includes("/rebase-apply/git-rebase-todo")
}

function firstEditablePoint(text: string): number {
  const comment = text.search(/^#/m)
  return comment < 0 ? 0 : comment
}

function fontLockSlice(buffer: BufferModel, range?: FontLockRange): { text: string; offset: number } {
  if (!range) return { text: buffer.text, offset: 0 }
  const startLine = Math.max(0, Math.min(range.startLine, buffer.lineCount - 1))
  const endLine = Math.max(startLine, Math.min(range.endLine, buffer.lineCount))
  const start = buffer.lineStarts[startLine] ?? 0
  const end = endLine < buffer.lineCount ? buffer.lineStarts[endLine]! : buffer.text.length
  return { text: buffer.text.slice(start, end), offset: start }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function helperScript(sessionDir: string, timeoutMs: number): string {
  return `#!/bin/sh
set -eu
dir=${shellSingleQuote(sessionDir)}
target=\${1:-}
if [ -z "$target" ]; then
  exit 1
fi
id="request-$$-$(date +%s 2>/dev/null || echo 0)"
request="$dir/$id"
reply="$request.reply"
tmp="$request.tmp"
printf '%s\\n%s\\n' "$target" "$reply" > "$tmp"
mv "$tmp" "$request"
timeout="\${JEMACS_WITH_EDITOR_TIMEOUT_MS:-${timeoutMs}}"
elapsed=0
while [ "$elapsed" -lt "$timeout" ]; do
  if [ -f "$reply" ]; then
    status=$(cat "$reply" 2>/dev/null || echo abort)
    rm -f "$reply"
    case "$status" in
      ok*) exit 0 ;;
      *) exit 1 ;;
    esac
  fi
  sleep 0.05
  elapsed=$((elapsed + 50))
done
exit 1
`
}
