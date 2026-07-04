/**
 * Browser stub for `node:fs`, `node:fs/promises`, `node:child_process`,
 * `node:module`, `bun:ffi`. The build script's `nodeStubPlugin` resolves those
 * specifiers here so the bundle has no `import "node:fs"` left in it.
 *
 * Every export is a function that throws on call (or a sentinel for the few
 * non-function names callers reference). This is the phase-5 stance per
 * shadow/DESIGN.md §Filesystem replica: the browser shadow has no local FS;
 * phase-6 routes these through manifest+CAS via `setPlatformRuntime`.
 */

class NotImplementedInBrowser extends Error {
  constructor(name: string) {
    super(`${name} is not available in the browser shadow (phase-6 supplies the manifest+CAS-backed runtime)`)
    this.name = "NotImplementedInBrowser"
  }
}

function stub(name: string): (...args: never[]) => never {
  return () => { throw new NotImplementedInBrowser(name) }
}

// node:fs (sync)
export const existsSync = (_: string): boolean => false
export const readFileSync = stub("fs.readFileSync")
export const writeFileSync = stub("fs.writeFileSync")
export const mkdirSync = stub("fs.mkdirSync")
export const statSync = stub("fs.statSync")
export const watch = stub("fs.watch")
export const createReadStream = stub("fs.createReadStream")
export const openSync = stub("fs.openSync")
export const closeSync = stub("fs.closeSync")
export const writeSync = stub("fs.writeSync")
export const unlinkSync = stub("fs.unlinkSync")
export const renameSync = stub("fs.renameSync")
export const readdirSync = stub("fs.readdirSync")
export const read = stub("fs.read")
export const write = stub("fs.write")
export const close = stub("fs.close")
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 }

// node:fs/promises
export const readFile = stub("fs/promises.readFile")
export const writeFile = stub("fs/promises.writeFile")
export const access = stub("fs/promises.access")
export const stat = stub("fs/promises.stat")
export const mkdir = stub("fs/promises.mkdir")
export const readdir = stub("fs/promises.readdir")
export const copyFile = stub("fs/promises.copyFile")
export const rename = stub("fs/promises.rename")
export const rm = stub("fs/promises.rm")
export const cp = stub("fs/promises.cp")
export const unlink = stub("fs/promises.unlink")
export const appendFile = stub("fs/promises.appendFile")
export const mkdtemp = stub("fs/promises.mkdtemp")
export const chmod = stub("fs/promises.chmod")
export const utimes = stub("fs/promises.utimes")
export const symlink = stub("fs/promises.symlink")
export const link = stub("fs/promises.link")
export const lstat = stub("fs/promises.lstat")
export const readlink = stub("fs/promises.readlink")

// node:child_process
export const spawn = stub("child_process.spawn")
export const spawnSync = stub("child_process.spawnSync")
export const exec = stub("child_process.exec")

// node:url — Bun's browser polyfill lacks fileURLToPath/pathToFileURL.
// Browser `import.meta.url` is an http(s) URL, so map both to/from pathname.
export function fileURLToPath(url: string | URL): string {
  const u = typeof url === "string" ? new URL(url, "file:///") : url
  return u.protocol === "file:" ? decodeURIComponent(u.pathname) : u.pathname
}
export function pathToFileURL(path: string): URL {
  return new URL(path.startsWith("/") ? `file://${path}` : `file:///${path}`)
}

// node:module — createRequire is called lazily by tree-sitter loader; the
// returned require throws so font-lock falls back to regex (it already
// try/catches the parser load).
export function createRequire(_: string): (id: string) => never {
  return id => { throw new NotImplementedInBrowser(`require(${JSON.stringify(id)})`) }
}

// bun:ffi
export const dlopen = stub("bun:ffi.dlopen")
export const ptr = stub("bun:ffi.ptr")

// Catch-all for any name we missed: a Proxy default whose every key is a stub.
// CJS-shaped imports (`import x from "node:fs"`) land here.
const handler: ProxyHandler<Record<string, unknown>> = {
  get: (_t, name) => {
    if (name === "__esModule") return true
    if (name === "default") return proxy
    return stub(String(name))
  },
}
const proxy: Record<string, unknown> = new Proxy({}, handler)
export default proxy
