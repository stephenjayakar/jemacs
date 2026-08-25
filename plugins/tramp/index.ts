import { dirname as posixDirname, basename as posixBasename, join as posixJoin } from "node:path/posix"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join as pathJoin } from "node:path"
import { Buffer } from "node:buffer"
import type { Editor } from "../../src/kernel/editor"
import { BufferModel, type SaveContext } from "../../src/kernel/buffer"
import { Keymap } from "../../src/kernel/keymap"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { homedir, spawnProcess } from "../../src/platform/runtime"
import { defineMode } from "../../src/modes/mode"
import { refreshDiredBuffer, type DiredEntry, type DiredFileOps } from "../../src/modes/dired"
import { createAskpassBroker, type AskpassBroker, type AskpassInteraction } from "./askpass"

export type TrampFileName = {
  method: "ssh" | "scp" | "sudo"
  user?: string
  host?: string
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
  copyFile?(from: TrampFileName, to: TrampFileName, recursive?: boolean): Promise<void>
  deleteFile(file: TrampFileName, recursive?: boolean): Promise<void>
  rename(from: TrampFileName, to: TrampFileName): Promise<void>
  mkdir(file: TrampFileName): Promise<void>
  touch(file: TrampFileName): Promise<void>
  close?(): Promise<void>
}

export type TrampOptions = {
  transport?: RemoteTransport
}

const TRAMP_RE = /^\/(ssh|scp):(?:(?<user>[^@/:#\s]+)@)?(?<host>[^:/#\s]+)(?:#(?<port>\d+))?:(?<localname>.*)$/
const SUDO_TRAMP_RE = /^\/sudo::(?<localname>.*)$/

export function parseTrampFileName(input: string): TrampFileName | null {
  const sudoMatch = SUDO_TRAMP_RE.exec(input)
  if (sudoMatch?.groups) {
    return {
      method: "sudo",
      localname: sudoMatch.groups.localname || "/",
    }
  }
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
  if (file.method === "sudo") return `/sudo::${localname}`
  const user = file.user ? `${file.user}@` : ""
  const port = file.port ? `#${file.port}` : ""
  return `/${file.method}:${user}${file.host}${port}:${localname}`
}

export function buildSshArgv(file: TrampFileName, script: string, controlPathDir: string): string[] {
  const target = `${file.user ? `${file.user}@` : ""}${file.host}`
  const cmd = [
    "ssh",
    "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=auto",
    "-o", "ControlPersist=60",
    "-o", `ControlPath=${pathJoin(controlPathDir, "jemacs-%r@%h-%p")}`,
  ]
  if (file.port) cmd.push("-p", String(file.port))
  cmd.push("--", target, script)
  return cmd
}

export function buildSshEnv(broker: AskpassBroker, baseEnv: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {
    SSH_ASKPASS: broker.script,
    SSH_ASKPASS_REQUIRE: "force",
    JEMACS_ASKPASS_DIR: broker.dir,
  }
  if (!baseEnv.DISPLAY) env.DISPLAY = ":0"
  return env
}

export class SshRemoteTransport implements RemoteTransport {
  private broker: AskpassBroker | null = null

  constructor(private readonly interaction: AskpassInteraction = { ask: async () => null }) {}

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

  async copyFile(from: TrampFileName, to: TrampFileName, recursive = false): Promise<void> {
    await this.ssh(from, `cp -p${recursive ? " -R" : ""} -- ${shQuote(from.localname)} ${shQuote(to.localname)}`)
  }

  async deleteFile(file: TrampFileName, recursive = false): Promise<void> {
    await this.ssh(file, `${recursive ? "rm -r" : "rm"} -- ${shQuote(file.localname)}`)
  }

  async rename(from: TrampFileName, to: TrampFileName): Promise<void> {
    await this.ssh(from, `mv -- ${shQuote(from.localname)} ${shQuote(to.localname)}`)
  }

  async mkdir(file: TrampFileName): Promise<void> {
    await this.ssh(file, `mkdir -p -- ${shQuote(file.localname)}`)
  }

  async touch(file: TrampFileName): Promise<void> {
    await this.ssh(file, `touch -- ${shQuote(file.localname)}`)
  }

  protected async ssh(file: TrampFileName, script: string, stdin?: string): Promise<{ stdout: string; stderr: string }> {
    const broker = await this.askpassBroker()
    const cmd = buildSshArgv(file, script, sshControlPathDirectory())
    const proc = spawnProcess({ cmd, env: buildSshEnv(broker), stdin: stdin == null ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" })
    if (stdin != null) {
      proc.stdin?.write(stdin)
      proc.stdin?.end()
    }
    const [stdout, stderr, code] = await Promise.all([
      readStream(proc.stdout),
      readStream(proc.stderr),
      proc.exited,
    ])
    if (code !== 0) {
      const message = stderr.trim() || `ssh exited ${code}`
      throw new Error(code === 255 ? `ssh failed: ${message} (an askpass prompt may have been dismissed)` : message)
    }
    return { stdout, stderr }
  }

  async close(): Promise<void> {
    await this.broker?.close()
    this.broker = null
  }

  private async askpassBroker(): Promise<AskpassBroker> {
    this.broker ??= await createAskpassBroker(this.interaction)
    return this.broker
  }
}

export class SudoRemoteTransport extends SshRemoteTransport {
  protected override async ssh(_file: TrampFileName, script: string, stdin?: string): Promise<{ stdout: string; stderr: string }> {
    const proc = spawnProcess({ cmd: ["sudo", "sh", "-c", script], stdin: stdin == null ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" })
    if (stdin != null) {
      proc.stdin?.write(stdin)
      proc.stdin?.end()
    }
    const [stdout, stderr, code] = await Promise.all([
      readStream(proc.stdout),
      readStream(proc.stderr),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || `sudo exited ${code}`)
    return { stdout, stderr }
  }
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor), options: TrampOptions = {}): void {
  defineMode({ name: "tramp", parent: "text", keymap: new Keymap("tramp-map") })
  ctx.minorMode({ name: "tramp-mode", lighter: " Tramp" })

  const interaction: AskpassInteraction = {
    ask: (prompt, promptOptions) => editor.prompt(prompt, "", undefined, promptOptions),
  }
  const transport = options.transport ?? new SshRemoteTransport(interaction)
  const sudoTransport = options.transport ?? new SudoRemoteTransport()
  const previousOpenFile = editor.openFile.bind(editor)
  const previousOpenDirectory = editor.openDirectory.bind(editor)
  const previousAutoSavePath = editor.autoSavePath.bind(editor)

  editor.openFile = async (path: string) => {
    const file = parseTrampFileName(path)
    if (!file) return previousOpenFile(path)
    return openTrampFile(editor, transportFor(file, transport, sudoTransport), file)
  }

  editor.openDirectory = async (path: string) => {
    const file = parseTrampFileName(path)
    if (!file) return previousOpenDirectory(path)
    return openTrampDirectory(editor, transportFor(file, transport, sudoTransport), file)
  }

  editor.autoSavePath = buffer => buffer.path && parseTrampFileName(buffer.path) ? null : previousAutoSavePath(buffer)

  ctx.onDispose(() => {
    editor.openFile = previousOpenFile
    editor.openDirectory = previousOpenDirectory
    editor.autoSavePath = previousAutoSavePath
    if (!options.transport) {
      void transport.close?.()
      void sudoTransport.close?.()
    }
  })
}

async function openTrampFile(editor: Editor, transport: RemoteTransport, file: TrampFileName): Promise<BufferModel> {
  const path = formatTrampFileName(file)
  try {
    editor.message(`tramp: connecting to ${file.host ?? "localhost"}...`)
    const kind = await transport.fileKind(file)
    if (kind === "directory") return openTrampDirectory(editor, transport, file, false)
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
  } catch (error) {
    // Rethrow so callers (find-file's "Opened ..." message) don't report success;
    // the command runner surfaces the message exactly once.
    throw new Error(`tramp: ${errorMessage(error)}`)
  }
}

async function openTrampDirectory(editor: Editor, transport: RemoteTransport, file: TrampFileName, announce = true): Promise<BufferModel> {
  const path = formatTrampFileName(file)
  try {
    if (announce) editor.message(`tramp: connecting to ${file.host ?? "localhost"}...`)
    const buffer = await editor.visitPath(path, async () => {
      const b = new BufferModel({ name: `${posixBasename(file.localname) || file.localname}/`, path, kind: "directory", mode: "dired" })
      b.readOnly = true
      b.minorModes.add("tramp-mode")
      b.locals.set("dired-file-ops", trampDiredFileOps(transport))
      await refreshDiredBuffer(b)
      return b
    }, "dired")
    editor.message(`Opened ${path}`)
    return buffer
  } catch (error) {
    throw new Error(`tramp: ${errorMessage(error)}`)
  }
}

function trampDiredFileOps(transport: RemoteTransport): DiredFileOps {
  const parse = (path: string) => {
    const file = parseTrampFileName(path)
    if (!file) throw new Error(`Not a TRAMP path: ${path}`)
    return file
  }
  return {
    async listDirectory(path: string): Promise<DiredEntry[]> {
      const file = parse(path)
      const parent = posixDirname(file.localname)
      return [
        {
          name: "..",
          path: formatTrampFileName(file, parent === "." ? "~" : parent),
          isDirectory: true,
          size: 0,
          mtime: new Date(0),
        },
        ...await transport.listDirectory(file),
      ]
    },
    async deleteFile(path: string, recursive = false): Promise<void> {
      await transport.deleteFile(parse(path), recursive)
    },
    async copyFile(from: string, to: string, recursive = false): Promise<void> {
      const source = parse(from)
      const dest = parse(to)
      if (!sameRemoteEndpoint(source, dest)) throw new Error(`Cannot copy between different TRAMP endpoints`)
      if (!transport.copyFile) throw new Error(`TRAMP transport does not support copy`)
      await transport.copyFile(source, dest, recursive)
    },
    async rename(from: string, to: string): Promise<void> {
      const source = parse(from)
      const dest = parse(to)
      if (!sameRemoteEndpoint(source, dest)) throw new Error(`Cannot rename between different TRAMP endpoints`)
      await transport.rename(source, dest)
    },
    async mkdir(path: string): Promise<void> {
      await transport.mkdir(parse(path))
    },
    async touch(path: string): Promise<void> {
      await transport.touch(parse(path))
    },
  }
}

function sameRemoteEndpoint(a: TrampFileName, b: TrampFileName): boolean {
  return a.method === b.method && a.user === b.user && a.host === b.host && a.port === b.port
}

function transportFor(file: TrampFileName, transport: RemoteTransport, sudoTransport: RemoteTransport): RemoteTransport {
  return file.method === "sudo" ? sudoTransport : transport
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

function sshControlPathDirectory(): string {
  const sshDir = pathJoin(homedir(), ".ssh")
  return existsSync(sshDir) ? sshDir : tmpdir()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
