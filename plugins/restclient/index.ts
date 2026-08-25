import type { Editor } from "../../src/kernel/editor"
import { BufferModel } from "../../src/kernel/buffer"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { spawnProcess, type SpawnHandle, type SpawnOptions } from "../../src/platform/runtime"
import { killNew } from "../../src/runtime/kill-ring"

export type RestclientRequest = {
  method: string
  url: string
  headers: Array<{ name: string; value: string }>
  body: string
  blockStart: number
  blockEnd: number
  requestStart: number
}

export type CurlInvocation = {
  cmd: string[]
  stdin: string | null
}

export type RestclientDeps = {
  spawn?: (opts: SpawnOptions) => SpawnHandle
}

const METHOD_RE = /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S.*)$/i
const VARIABLE_RE = /^\s*:([A-Za-z_][\w-]*)\s*=\s*(.*)$/
const HEADER_RE = /^\s*([^:\s][^:]*):\s*(.*)$/
const SEPARATOR_RE = /^\s*#/

function lineEndIncludingNewline(text: string, lineStart: number): number {
  const nl = text.indexOf("\n", lineStart)
  return nl === -1 ? text.length : nl + 1
}

function lineText(text: string, lineStart: number): string {
  const end = text.indexOf("\n", lineStart)
  const raw = text.slice(lineStart, end === -1 ? text.length : end)
  return raw.replace(/\r$/, "")
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && i + 1 < text.length) starts.push(i + 1)
  return starts
}

function isSeparatorLine(text: string, start: number): boolean {
  return SEPARATOR_RE.test(lineText(text, start))
}

function collectVariables(text: string, end: number): Map<string, string> {
  const variables = new Map<string, string>()
  for (const start of lineStarts(text.slice(0, end))) {
    const match = VARIABLE_RE.exec(lineText(text, start))
    if (match) variables.set(match[1]!, match[2]!)
  }
  return variables
}

function substituteVariables(text: string, variables: Map<string, string>): string {
  return text.replace(/:([A-Za-z_][\w-]*)/g, (whole, name: string) => variables.get(name) ?? whole)
}

function blockBoundsAt(text: string, point: number): { start: number; end: number } {
  const clamped = Math.max(0, Math.min(point, text.length))
  let start = 0
  for (const lineStart of lineStarts(text)) {
    if (lineStart >= clamped) break
    if (isSeparatorLine(text, lineStart)) start = lineEndIncludingNewline(text, lineStart)
  }

  let end = text.length
  for (const lineStart of lineStarts(text)) {
    if (lineStart <= clamped) continue
    if (isSeparatorLine(text, lineStart)) {
      end = lineStart
      break
    }
  }
  return { start, end }
}

export function parseRequestAt(text: string, point: number): RestclientRequest | null {
  const { start: blockStart, end: blockEnd } = blockBoundsAt(text, point)
  const starts = lineStarts(text.slice(blockStart, blockEnd)).map(n => n + blockStart)

  let requestStart = -1
  let requestMatch: RegExpExecArray | null = null
  for (const start of starts) {
    const match = METHOD_RE.exec(lineText(text, start))
    if (match) {
      requestStart = start
      requestMatch = match
      break
    }
  }
  if (!requestMatch) return null

  const variables = collectVariables(text, requestStart)
  const method = requestMatch[1]!.toUpperCase()
  const url = substituteVariables(requestMatch[2]!.trim(), variables)
  const headers: RestclientRequest["headers"] = []
  let bodyStart = blockEnd
  let cursor = lineEndIncludingNewline(text, requestStart)

  while (cursor < blockEnd) {
    const raw = lineText(text, cursor)
    if (/^\s*$/.test(raw)) {
      bodyStart = lineEndIncludingNewline(text, cursor)
      break
    }
    const header = HEADER_RE.exec(raw)
    if (!header) {
      bodyStart = cursor
      break
    }
    headers.push({
      name: header[1]!.trim(),
      value: substituteVariables(header[2]!.trim(), variables),
    })
    cursor = lineEndIncludingNewline(text, cursor)
  }

  const body = bodyStart < blockEnd
    ? substituteVariables(text.slice(bodyStart, blockEnd).replace(/\r?\n$/, ""), variables)
    : ""

  return { method, url, headers, body, blockStart, blockEnd, requestStart }
}

export function buildCurlInvocation(request: RestclientRequest): CurlInvocation {
  const cmd = ["curl", "-sS", "-i", "-X", request.method]
  for (const header of request.headers) cmd.push("-H", `${header.name}: ${header.value}`)
  if (request.body.length > 0) cmd.push("--data-binary", "@-")
  cmd.push(request.url)
  return { cmd, stdin: request.body.length > 0 ? request.body : null }
}

export function shellQuoteArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function curlCommandString(invocation: CurlInvocation): string {
  const cmd = invocation.cmd.map(shellQuoteArg).join(" ")
  return invocation.stdin == null ? cmd : `${cmd} <<'EOF'\n${invocation.stdin}\nEOF`
}

export function requestStarts(text: string): number[] {
  const out: number[] = []
  const starts = lineStarts(text)
  for (const start of starts) {
    if (isSeparatorLine(text, start)) continue
    if (METHOD_RE.test(lineText(text, start))) out.push(start)
  }
  return out
}

export function nextRequestPoint(text: string, point: number): number | null {
  return requestStarts(text).find(start => start > point) ?? null
}

export function previousRequestPoint(text: string, point: number): number | null {
  const starts = requestStarts(text).filter(start => start < point)
  return starts.length ? starts[starts.length - 1]! : null
}

export function formatHttpResponse(raw: string, prettyJson: boolean): string {
  if (!prettyJson) return raw
  const lastBreak = Math.max(raw.lastIndexOf("\r\n\r\n"), raw.lastIndexOf("\n\n"))
  if (lastBreak < 0) return raw
  const sep = raw.startsWith("\r\n\r\n", lastBreak) ? "\r\n\r\n" : "\n\n"
  const head = raw.slice(0, lastBreak)
  const body = raw.slice(lastBreak + sep.length)
  if (!/^\s*content-type\s*:.*json\b/im.test(head)) return raw
  try {
    const eol = sep.startsWith("\r\n") ? "\r\n" : "\n"
    return `${head}${sep}${JSON.stringify(JSON.parse(body), null, 2).replace(/\n/g, eol)}${eol}`
  } catch {
    return raw
  }
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value?.length) out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

async function runCurl(invocation: CurlInvocation, deps: RestclientDeps): Promise<string> {
  const spawn = deps.spawn ?? spawnProcess
  const proc = spawn({ cmd: invocation.cmd, stdin: invocation.stdin == null ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" })
  if (invocation.stdin != null) {
    proc.stdin?.write(invocation.stdin)
    proc.stdin?.end()
  }
  const [stdout, stderr, code] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr), proc.exited])
  if (code !== 0) return stdout + (stderr ? `\n${stderr}` : "")
  return stdout + stderr
}

async function sendCurrent(editor: Editor, buffer: BufferModel, deps: RestclientDeps, prettyJson: boolean): Promise<void> {
  const request = parseRequestAt(buffer.text, buffer.point)
  if (!request) {
    editor.message("No REST request at point")
    return
  }
  const output = await runCurl(buildCurlInvocation(request), deps)
  const text = formatHttpResponse(output, prettyJson)
  let response = [...editor.buffers.values()].find(b => b.name === "*HTTP Response*")
  if (response) {
    response.readOnly = false
    response.setText(text, false)
    editor.enterMode(response, "text")
  } else {
    response = editor.addBuffer(new BufferModel({ name: "*HTTP Response*", text, kind: "scratch", mode: "text" }))
  }
  response.readOnly = true
  editor.displayBufferInOtherWindow(response.id, { select: true })
}

export function install(editor: Editor, deps: RestclientDeps = {}, ctx: PluginContext = createPluginContext(editor)): void {
  ctx.command("restclient-http-send-current", async ({ editor, buffer }) => {
    await sendCurrent(editor, buffer, deps, true)
  }, "Execute the REST request at point and pretty-print JSON responses.")

  ctx.command("restclient-http-send-current-raw", async ({ editor, buffer }) => {
    await sendCurrent(editor, buffer, deps, false)
  }, "Execute the REST request at point without response body pretty-printing.")

  ctx.command("restclient-jump-next", ({ editor, buffer }) => {
    const point = nextRequestPoint(buffer.text, buffer.point)
    if (point == null) editor.message("No next REST request")
    else buffer.point = point
  }, "Move point to the next REST request.")

  ctx.command("restclient-jump-previous", ({ editor, buffer }) => {
    const point = previousRequestPoint(buffer.text, buffer.point)
    if (point == null) editor.message("No previous REST request")
    else buffer.point = point
  }, "Move point to the previous REST request.")

  ctx.command("restclient-copy-curl-command", ({ editor, buffer }) => {
    const request = parseRequestAt(buffer.text, buffer.point)
    if (!request) {
      editor.message("No REST request at point")
      return
    }
    const text = curlCommandString(buildCurlInvocation(request))
    killNew(editor, text)
    editor.message("Copied curl command")
  }, "Copy the REST request at point as a curl command.")

  ctx.key("restclient-map", "C-c C-c", "restclient-http-send-current")
  ctx.key("restclient-map", "C-c C-r", "restclient-http-send-current-raw")
  ctx.key("restclient-map", "C-c C-n", "restclient-jump-next")
  ctx.key("restclient-map", "C-c C-p", "restclient-jump-previous")
  ctx.key("restclient-map", "C-c C-u", "restclient-copy-curl-command")
}
