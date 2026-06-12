import { spawn as nodeSpawn } from "node:child_process"
import { createHash } from "node:crypto"
import { constants, existsSync, watch as nodeWatch } from "node:fs"
import { access, cp as nodeCp, mkdir as nodeMkdir, readFile, readdir as nodeReaddir, rename as nodeRename, rm as nodeRm, stat as nodeStat, unlink as nodeUnlink, writeFile } from "node:fs/promises"
import { homedir as nodeHomedir } from "node:os"
import { join } from "node:path"
import type { Readable } from "node:stream"

export type StatLike = { mode: number; size: number; mtime: number }

const S_IFDIR = 0o040000
/** True when `st.mode` has the directory bit — works for both nodeRuntime
 *  (POSIX `st_mode`) and RemoteRuntime (manifest entries use the same bit). */
export function isDirectory(st: StatLike): boolean {
  return (st.mode & S_IFDIR) !== 0
}

/** Returned by `watch`; call `close()` to stop receiving events. */
export type WatchHandle = { close(): void }

/**
 * The sole I/O seam between the editor (kernel/lisp/modes/plugins) and the
 * host. Mirrors the `UiHost` display seam (ARCHITECTURE.md): a new host
 * implements `PlatformRuntime` and the editor never imports `node:*` directly.
 *
 * Hosts: `nodeRuntime` below for authority/tty/Electron; `RemoteRuntime`
 * (shadow/remote-runtime.ts) for the browser shadow, backed by manifest+CAS.
 * The Editor is constructed with one of these — `editor.runtime` is how
 * commands reach the filesystem, env, and crypto.
 */
export type PlatformRuntime = {
  readFileText(path: string): Promise<string>
  writeFileText(path: string, text: string): Promise<void>
  fileExists(path: string): Promise<boolean>
  stat(path: string): Promise<StatLike | null>
  /** Remove a file. Optional: hosts that lack it (RemoteRuntime today) fall
   *  through to nodeRuntime; callers already `.catch` the no-op throw. */
  unlink?(path: string): Promise<void>
  readdir(dir: string): Promise<string[]>
  /** Create a directory. Optional like `unlink` — RemoteRuntime ships these as
   *  link commands when it implements them; until then dired's mutating ops
   *  fall through to nodeRuntime (which throws in the browser stub, surfacing
   *  a clean error rather than silently no-op'ing). */
  mkdir?(path: string, opts?: { recursive?: boolean }): Promise<void>
  cp?(src: string, dest: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>
  rename?(src: string, dest: string): Promise<void>
  rm?(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>
  spawnProcess(options: SpawnOptions): SpawnHandle
  whichExecutable(name: string): string | null
  /** Hex sha256 of `text` — the CAS/BufferRef key. */
  hash(text: string): string
  /** Process working directory (or the project root the shadow is attached to). */
  cwd(): string
  /** Single environment-variable lookup. */
  env(name: string): string | undefined
  /** User home directory (or the shadow's virtual `~`). */
  homedir(): string
  /** Watch `path` for changes. Returns a no-op handle when watching is unsupported. */
  watch(path: string, onChange: () => void): WatchHandle
}

let override: Partial<PlatformRuntime> | undefined

export function setPlatformRuntime(impl: Partial<PlatformRuntime> | undefined): void {
  override = impl
}

/** Current override, for save/restore around a scoped install (attachShadow). */
export function getPlatformRuntime(): Partial<PlatformRuntime> | undefined {
  return override
}

export type SpawnOptions = {
  cmd: string[]
  cwd?: string
  stdin?: "pipe" | "ignore"
  stdout?: "pipe" | "ignore"
  stderr?: "pipe" | "ignore"
}

export type SpawnHandle = {
  stdin: { write(chunk: string): void; end(): void } | null
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
  exited: Promise<number | null>
  kill(): void
}

function nodeReadableToWeb(stream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      stream.on("data", chunk => {
        const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
        controller.enqueue(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
      })
      stream.on("end", () => controller.close())
      stream.on("error", error => controller.error(error))
    },
    cancel() {
      stream.destroy()
    },
  })
}

function nodeSpawnProcess(options: SpawnOptions): SpawnHandle {
  if (typeof Bun !== "undefined") {
    const proc = Bun.spawn({
      cmd: options.cmd,
      cwd: options.cwd,
      stdin: options.stdin ?? "ignore",
      stdout: options.stdout ?? "ignore",
      stderr: options.stderr ?? "ignore",
    })
    return {
      stdin: proc.stdin
        ? { write: chunk => proc.stdin!.write(chunk), end: () => proc.stdin!.end() }
        : null,
      stdout: proc.stdout ?? null,
      stderr: proc.stderr ?? null,
      exited: proc.exited.then(code => code),
      kill: () => proc.kill(),
    }
  }

  const proc = nodeSpawn(options.cmd[0]!, options.cmd.slice(1), {
    cwd: options.cwd,
    stdio: [
      options.stdin === "pipe" ? "pipe" : "ignore",
      options.stdout === "pipe" ? "pipe" : "ignore",
      options.stderr === "pipe" ? "pipe" : "ignore",
    ],
  })

  return {
    stdin: proc.stdin
      ? { write: chunk => proc.stdin!.write(chunk), end: () => proc.stdin!.end() }
      : null,
    stdout: proc.stdout ? nodeReadableToWeb(proc.stdout) : null,
    stderr: proc.stderr ? nodeReadableToWeb(proc.stderr) : null,
    exited: new Promise(resolve => {
      proc.on("close", code => resolve(code))
      proc.on("error", () => resolve(null))
    }),
    kill: () => proc.kill(),
  }
}

function nodeWhich(name: string): string | null {
  if (name.includes("/")) return existsSync(name) ? name : null
  const pathEnv = process.env.PATH ?? ""
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue
    const full = join(dir, name)
    if (existsSync(full)) return full
  }
  return null
}

/** The Bun/Node host runtime. The authority side and the tty/Electron entry
 *  points construct the Editor with this; it is the only place outside
 *  `src/web/host.ts` permitted to import `node:*`. */
export const nodeRuntime: PlatformRuntime = {
  async readFileText(path) {
    try {
      return await readFile(path, "utf8")
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ""
      throw error
    }
  },
  async writeFileText(path, text) {
    await writeFile(path, text, "utf8")
  },
  async fileExists(path) {
    try {
      await access(path, constants.F_OK)
      return true
    } catch {
      return false
    }
  },
  async stat(path) {
    try {
      const s = await nodeStat(path)
      return { mode: s.mode, size: s.size, mtime: s.mtimeMs }
    } catch {
      return null
    }
  },
  async unlink(path) {
    await nodeUnlink(path)
  },
  async mkdir(path, opts) {
    await nodeMkdir(path, opts)
  },
  async cp(src, dest, opts) {
    await nodeCp(src, dest, opts)
  },
  async rename(src, dest) {
    await nodeRename(src, dest)
  },
  async rm(path, opts) {
    await nodeRm(path, opts)
  },
  async readdir(dir) {
    try {
      return await nodeReaddir(dir)
    } catch {
      return []
    }
  },
  spawnProcess: nodeSpawnProcess,
  whichExecutable: nodeWhich,
  hash(text) {
    return createHash("sha256").update(text).digest("hex")
  },
  cwd() {
    return process.cwd()
  },
  env(name) {
    return process.env[name]
  },
  homedir() {
    return nodeHomedir()
  },
  watch(path, onChange) {
    try {
      const w = nodeWatch(path, { persistent: false }, () => onChange())
      return { close: () => w.close() }
    } catch {
      return { close: () => {} }
    }
  },
}

// ── Module-level free functions ─────────────────────────────────────────────
// These delegate through the installed override (RemoteRuntime in the shadow)
// and fall back to nodeRuntime. Prefer `editor.runtime.*` in new code; these
// remain for call sites without an Editor in scope.

export function whichExecutable(name: string): string | null {
  return (override?.whichExecutable ?? nodeRuntime.whichExecutable)(name)
}

export async function fileExists(path: string): Promise<boolean> {
  return (override?.fileExists ?? nodeRuntime.fileExists)(path)
}

export async function readFileText(path: string): Promise<string> {
  return (override?.readFileText ?? nodeRuntime.readFileText)(path)
}

export async function writeFileText(path: string, text: string): Promise<void> {
  return (override?.writeFileText ?? nodeRuntime.writeFileText)(path, text)
}

export async function stat(path: string): Promise<StatLike | null> {
  return (override?.stat ?? nodeRuntime.stat)(path)
}

export async function unlink(path: string): Promise<void> {
  return (override?.unlink ?? nodeRuntime.unlink!)(path)
}

export async function readdir(dir: string): Promise<string[]> {
  return (override?.readdir ?? nodeRuntime.readdir)(dir)
}

export async function mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
  return (override?.mkdir ?? nodeRuntime.mkdir!)(path, opts)
}

export async function cp(src: string, dest: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
  return (override?.cp ?? nodeRuntime.cp!)(src, dest, opts)
}

export async function rename(src: string, dest: string): Promise<void> {
  return (override?.rename ?? nodeRuntime.rename!)(src, dest)
}

export async function rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
  return (override?.rm ?? nodeRuntime.rm!)(path, opts)
}

/** Spawn a subprocess in Bun or Node (Electron main uses Node). */
export function spawnProcess(options: SpawnOptions): SpawnHandle {
  return (override?.spawnProcess ?? nodeRuntime.spawnProcess)(options)
}

export function hash(text: string): string {
  return (override?.hash ?? nodeRuntime.hash)(text)
}

export function cwd(): string {
  return (override?.cwd ?? nodeRuntime.cwd)()
}

export function env(name: string): string | undefined {
  return (override?.env ?? nodeRuntime.env)(name)
}

export function homedir(): string {
  return (override?.homedir ?? nodeRuntime.homedir)()
}

export function watch(path: string, onChange: () => void): WatchHandle {
  return (override?.watch ?? nodeRuntime.watch)(path, onChange)
}

/** Minimal Bun surface for `M-x eval` in Electron (full Bun when running under Bun). */
export function runtimeBun(): typeof Bun {
  if (typeof Bun !== "undefined") return Bun
  return {
    file: (path: string) => ({
      exists: () => fileExists(path),
      text: () => readFileText(path),
    }),
    write: writeFileText,
    which: whichExecutable,
    spawn: (opts: SpawnOptions & { cmd?: string[] }) =>
      spawnProcess({ ...opts, cmd: opts.cmd ?? (opts as { command?: string[] }).command ?? [] }),
    argv: process.argv,
  } as unknown as typeof Bun
}
