export type RebaseTodoAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop"

export type RebaseRunResult = { out: string; err: string; code: number | null }

export type RebaseRunner = (
  args: string[],
  cwd: string,
  env: Record<string, string>,
) => Promise<RebaseRunResult>

export function parseGitLogForRebaseTodo(output: string): string {
  const lines = output.split("\n")
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => `pick ${line}`)
  return lines.length ? lines.join("\n") + "\n" : ""
}

export function changeTodoActionAtPoint(text: string, point: number, action: RebaseTodoAction): { text: string; point: number } {
  const { start, end } = lineBounds(text, point)
  const line = text.slice(start, end)
  const match = /^(\s*)(pick|reword|edit|squash|fixup|drop)(\s+)/.exec(line)
  if (!match) return { text, point }
  const actionStart = start + match[1]!.length
  const actionEnd = actionStart + match[2]!.length
  const next = text.slice(0, actionStart) + action + text.slice(actionEnd)
  const delta = action.length - match[2]!.length
  const nextPoint = point <= actionEnd ? Math.min(point, actionStart + action.length) : point + delta
  return { text: next, point: clamp(nextPoint, 0, next.length) }
}

export function moveTodoLine(text: string, point: number, direction: 1 | -1): { text: string; point: number } {
  const lines = splitPreservingFinalNewline(text)
  if (lines.length <= 1) return { text, point }
  const current = lineIndexAt(text, point)
  const target = current + direction
  if (target < 0 || target >= lines.length) return { text, point }

  const column = point - lineStartOffset(lines, current)
  const [line] = lines.splice(current, 1)
  lines.splice(target, 0, line!)
  const next = lines.join("")
  const nextStart = lineStartOffset(lines, target)
  const nextLineLength = lineTextLength(lines[target] ?? "")
  return { text: next, point: clamp(nextStart + Math.min(column, nextLineLength), 0, next.length) }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildInteractiveRebaseInvocation(base: string, todoPath: string): { args: string[]; env: Record<string, string> } {
  return {
    args: ["rebase", "-i", base],
    env: {
      GIT_SEQUENCE_EDITOR: `cp ${shellQuote(todoPath)}`,
      GIT_EDITOR: "true",
    },
  }
}

export async function runInteractiveRebaseTodo(options: {
  base: string
  cwd: string
  todoText: string
  todoPath: string
  writeTodoFile: (path: string, text: string) => Promise<void>
  runner: RebaseRunner
}): Promise<RebaseRunResult & { args: string[]; env: Record<string, string> }> {
  await options.writeTodoFile(options.todoPath, options.todoText)
  const { args, env } = buildInteractiveRebaseInvocation(options.base, options.todoPath)
  const result = await options.runner(args, options.cwd, env)
  return { ...result, args, env }
}

function lineBounds(text: string, point: number): { start: number; end: number } {
  const p = clamp(point, 0, text.length)
  const previous = p <= 0 ? -1 : text.lastIndexOf("\n", p - 1)
  const next = text.indexOf("\n", p)
  return { start: previous + 1, end: next === -1 ? text.length : next }
}

function lineIndexAt(text: string, point: number): number {
  return text.slice(0, clamp(point, 0, text.length)).split("\n").length - 1
}

function splitPreservingFinalNewline(text: string): string[] {
  if (!text) return [""]
  const raw = text.split("\n")
  const lines = raw.slice(0, -1).map(line => `${line}\n`)
  const tail = raw.at(-1) ?? ""
  if (tail) lines.push(tail)
  return lines
}

function lineStartOffset(lines: string[], line: number): number {
  let offset = 0
  for (let i = 0; i < line; i++) offset += lines[i]!.length
  return offset
}

function lineTextLength(line: string): number {
  return line.endsWith("\n") ? line.length - 1 : line.length
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}
