import { dirname as posixDirname, basename as posixBasename, join as posixJoin } from "node:path/posix"
import { Buffer } from "node:buffer"
import type { Editor } from "../../src/kernel/editor"
import { BufferModel, type SaveContext } from "../../src/kernel/buffer"
import { Keymap } from "../../src/kernel/keymap"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { spawnProcess } from "../../src/platform/runtime"
import { defineMode } from "../../src/modes/mode"
import { diredEntryLines, renderDiredBuffer, type DiredEntry } from "../../src/modes/dired"

export type TrampFileName = {
  method: "ssh" | "scp"
  user?: string
  host: string
  port?: number
  localname: string
}

export type RemoteFileKind = "file" | "directory" | "missing"

export type RemoteTransport = {
  fileKind(file: TrampFileName): Promise<RemoteFileKind>
  readFile(file: TrampFileName): Promise<string>
  writeFile(file: TrampFileName, text: string): Promise<void>
  statMtime(file: TrampFileName): Promise<number | undefined>
  listDirectory(file: TrampFileName): Promise<DiredEntry[]>
  copyFile?(from: TrampFileName, to: TrampFileName): Promise<void>
}

export type TrampOptions = {
  transport?: RemoteTransport
}

const TRAMP_RE = /^\/(ssh|scp):(?:(?<user>[^@/:#\s]+)@)?(?<host>[^:/#\s]+)(?:#(?<port>\d+))?:(?<localname>.*)$/

export function parseTrampFileName(input: string): TrampFileName | null {
  const match = TRAMP_RE.exec(input)
  if (!match?.groups) return null
  const method = match[1] as TrampFileName["method"]
  const port = match.groups.port ? Number(match.groups.port) : undefined
  if (port != null && (!Number.isInteger(port) || port <= 0)) return null
  return {
    method,
    user: match.groups.user,
    host: match.groups.host,
    port,
    localname: match.groups.localname || "~",
  }
}

export function formatTrampFileName(file: TrampFileName, localname = file.localname): string {
  const user = file.user ? `${file.user}@` : ""
  const port = file.port ? `#${file.port}` : ""
  return `/${file.method}:${user}${file.host}${port}:${localname}`
}

export class SshRemoteTransport implements RemoteTransport {
  async fileKind(file: TrampFileName): Promise<RemoteFileKind> {
    const result = await this.ssh(file, `if [ -d ${shQuote(file.localname)} ]; then printf directory; elif [ -e ${shQuote(file.localname)} ]; then printf file; else printf missing; fi`)
    const kind = result.stdout.trim()
    if (kind === "directory" || kind === "file" || kind === "missing") return kind
    throw new Error(`Unexpected TRAMP stat response: ${kind}`)
  }

  async readFile(file: TrampFileName): Promise<string> {
    const result = await this.ssh(file, `if [ -e ${shQuote(file.localname)} ]; then cat -- ${shQuote(file.localname)}; fi`)
    return result.stdout
  }

  async writeFile(file: TrampFileName, text: string): Promise<void> {
    const dir = posixDirname(file.localname)
    await this.ssh(file, `mkdir -p -- ${shQuote(dir)} && cat > ${shQuote(file.localname)}`, text)
  }

  async statMtime(file: TrampFileName): Promise<number | undefined> {
    const path = shQuote(file.localname)
    const result = await this.ssh(file, `(stat -c %Y ${path} 2>/dev/null || stat -f %m ${path} 2>/dev/null) | head -n 1`)
    const seconds = Number(result.stdout.trim())
    return Number.isFinite(seconds) ? seconds * 1000 : undefined
  }

  async listDirectory(file: TrampFileName): Promise<DiredEntry[]> {
    const script = `
dir=${shQuote(file.localname)}
for p in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
  [ -e "$p" ] || continue
  name=\${p##*/}
  [ "$name" = "." ] && continue
  [ "$name" = ".." ] && continue
  if [ -d "$p" ]; then type=d; size=0; else type=f; size=$(wc -c < "$p" 2>/dev/null || printf 0); fi
  mtime=$( (stat -c %Y "$p" 2>/dev/null || stat -f %m "$p" 2>/dev/null) | head -n 1 )
  printf '%s\\t%s\\t%s\\t%s\\n' "$name" "$type" "$size" "$mtime"
done
`
    const result = await this.ssh(file, script)
    return result.stdout.split("\n").filter(Boolean).map(line => {
      const [name = "", type = "f", size = "0", mtime = "0"] = line.split("\t")
      const localname = posixJoin(file.localname, name)
      return {
        name,
        path: formatTrampFileName(file, localname),
        isDirectory: type === "d",
        size: Number(size) || 0,
        mtime: new Date((Number(mtime) || 0) * 1000),
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
  }

  async copyFile(from: TrampFileName, to: TrampFileName): Promise<void> {
    await this.ssh(from, `cp -p -- ${shQuote(from.localname)} ${shQuote(to.localname)}`)
  }

  private async ssh(file: TrampFileName, script: string, stdin?: string): Promise<{ stdout: string; stderr: string }> {
    const target = `${file.user ? `${file.user}@` : ""}${file.host}`
    const cmd = ["ssh"]
    if (file.port) cmd.push("-p", String(file.port))
    cmd.push("--", target, script)
    const proc = spawnProcess({ cmd, stdin: stdin == null ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" })
    if (stdin != null) {
      proc.stdin?.write(stdin)
      proc.stdin?.end()
    }
    const [stdout, stderr, code] = await Promise.all([
      readStream(proc.stdout),
      readStream(proc.stderr),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || `ssh exited ${code}`)
    return { stdout, stderr }
  }
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor), options: TrampOptions = {}): void {
  defineMode({ name: "tramp", parent: "text", keymap: new Keymap("tramp-map") })
  ctx.minorMode({ name: "tramp-mode", lighter: " Tramp" })

  const transport = options.transport ?? new SshRemoteTransport()
  const previousOpenFile = editor.openFile.bind(editor)
  const previousOpenDirectory = editor.openDirectory.bind(editor)
  const previousAutoSavePath = editor.autoSavePath.bind(editor)

  editor.openFile = async (path: string) => {
    const file = parseTrampFileName(path)
    if (!file) return previousOpenFile(path)
    return openTrampFile(editor, transport, file)
  }

  editor.openDirectory = async (path: string) => {
    const file = parseTrampFileName(path)
    if (!file) return previousOpenDirectory(path)
    return openTrampDirectory(editor, transport, file)
  }

  editor.autoSavePath = buffer => buffer.path && parseTrampFileName(buffer.path) ? null : previousAutoSavePath(buffer)

  ctx.onDispose(() => {
    editor.openFile = previousOpenFile
    editor.openDirectory = previousOpenDirectory
    editor.autoSavePath = previousAutoSavePath
  })
}

async function openTrampFile(editor: Editor, transport: RemoteTransport, file: TrampFileName): Promise<BufferModel> {
  const path = formatTrampFileName(file)
  const kind = await transport.fileKind(file)
  if (kind === "directory") return openTrampDirectory(editor, transport, file)
  const buffer = await visitWithoutLsp(editor, path, async () => {
    const text = kind === "missing" ? "" : await transport.readFile(file)
    const b = new BufferModel({ name: posixBasename(file.localname), path, text, kind: "file" })
    b.minorModes.add("tramp-mode")
    patchTrampBuffer(b, transport, file)
    b.markSaved(kind === "missing" ? undefined : await transport.statMtime(file))
    return b
  })
  editor.message(`Opened ${path}`)
  return buffer
}

async function openTrampDirectory(editor: Editor, transport: RemoteTransport, file: TrampFileName): Promise<BufferModel> {
  const path = formatTrampFileName(file)
  const buffer = await editor.visitPath(path, async () => {
    const entries = await transport.listDirectory(file)
    const parent = posixDirname(file.localname)
    const allEntries: DiredEntry[] = [
      {
        name: "..",
        path: formatTrampFileName(file, parent === "." ? "~" : parent),
        isDirectory: true,
        size: 0,
        mtime: new Date(0),
      },
      ...entries,
    ]
    const b = new BufferModel({ name: `${posixBasename(file.localname) || file.localname}/`, path, kind: "directory", mode: "dired" })
    b.readOnly = true
    b.minorModes.add("tramp-mode")
    diredEntryLines.set(b, allEntries)
    renderDiredBuffer(b, allEntries)
    return b
  }, "dired")
  editor.message(`Opened ${path}`)
  return buffer
}

async function visitWithoutLsp(editor: Editor, path: string, make: () => Promise<BufferModel>): Promise<BufferModel> {
  const previousLsp = editor.lsp
  editor.lsp = null
  try {
    return await editor.visitPath(path, make)
  } finally {
    editor.lsp = previousLsp
  }
}

function patchTrampBuffer(buffer: BufferModel, transport: RemoteTransport, file: TrampFileName): void {
  const currentFile = () => {
    const parsed = buffer.path ? parseTrampFileName(buffer.path) : null
    return parsed ?? file
  }

  buffer.directory = () => formatTrampFileName(currentFile(), posixDirname(currentFile().localname))

  buffer.verifyVisitedFileModtime = async () => {
    if (buffer.visitedFileModtime == null) return true
    const mtime = await transport.statMtime(currentFile())
    return mtime == null || mtime <= buffer.visitedFileModtime
  }

  buffer.revert = async () => {
    const tramp = currentFile()
    const text = await transport.readFile(tramp)
    buffer.setText(text, false)
    buffer.markSaved(await transport.statMtime(tramp))
  }

  buffer.save = async (saveCtx: SaveContext = {}) => {
    const tramp = currentFile()
    await saveCtx.runHook?.("before-save-hook", buffer)
    if (!saveCtx.force && !(await buffer.verifyVisitedFileModtime())) {
      const ok = await saveCtx.confirm?.(`${buffer.name} has changed on disk; save anyway?`)
      if (ok !== true) throw new Error(`File ${buffer.path} changed on remote host since visited`)
    }
    if ((saveCtx.makeBackupFiles ?? true) && !buffer.locals.get("tramp-backed-up") && await transport.fileKind(tramp) === "file") {
      if (transport.copyFile) await transport.copyFile(tramp, { ...tramp, localname: `${tramp.localname}~` })
      buffer.locals.set("tramp-backed-up", true)
    }
    await transport.writeFile(tramp, buffer.text)
    buffer.markSaved(await transport.statMtime(tramp))
    await saveCtx.runHook?.("after-save-hook", buffer)
  }
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
