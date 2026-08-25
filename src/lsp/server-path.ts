import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { BufferModel } from "../kernel/buffer"
import { whichExecutable } from "../platform/runtime"
import { getCustom } from "../runtime/custom"

/** Same layout as lsp-mode `lsp--npm-dependency-path` (~/.emacs.d/.cache/lsp/npm/…/bin/). */
export function emacsLspNpmBinary(packageName: string, binaryName = packageName): string | null {
  const candidate = join(
    homedir(),
    ".emacs.d",
    ".cache",
    "lsp",
    "npm",
    packageName,
    "bin",
    binaryName,
  )
  return existsSync(candidate) ? candidate : null
}

function jemacsHome(): string | null {
  const home = process.env.JEMACS_HOME
  if (!home) return null
  const resolved = resolve(home)
  return existsSync(resolved) ? resolved : null
}

function nodeModulesBin(name: string, root: string): string | null {
  const candidate = join(root, "node_modules", ".bin", name)
  return existsSync(candidate) ? candidate : null
}

/** Walk from `startDir` toward `/` looking for `node_modules/.bin/<name>`. */
function walkNodeModulesBin(name: string, startDir: string): string | null {
  let dir = resolve(startDir)
  const root = resolve("/")
  while (true) {
    const candidate = nodeModulesBin(name, dir)
    if (candidate) return candidate
    const parent = dirname(dir)
    if (parent === dir || dir === root) break
    dir = parent
  }
  return null
}

/** Resolve an LSP server executable: PATH, project tree, JEMACS_HOME, then Emacs lsp-mode cache. */
export function findServerBinary(name: string, searchFrom?: string): string | null {
  const onPath = whichExecutable(name)
  if (onPath) return onPath

  if (searchFrom) {
    let dir = resolve(searchFrom)
    try {
      if (statSync(dir).isFile()) dir = dirname(dir)
    } catch {
      dir = dirname(dir)
    }
    const fromProject = walkNodeModulesBin(name, dir)
    if (fromProject) return fromProject
  } else {
    const fromCwd = walkNodeModulesBin(name, process.cwd())
    if (fromCwd) return fromCwd
  }

  const home = jemacsHome()
  if (home) {
    const fromHome = nodeModulesBin(name, home)
    if (fromHome) return fromHome
  }

  return emacsLspNpmBinary(name)
}

export function searchRootForBuffer(buffer?: BufferModel): string {
  if (buffer?.path) return dirname(resolve(buffer.path))
  return process.cwd()
}

export function serverBinaryAvailable(name: string, buffer?: BufferModel): boolean {
  if (getCustom<string>("lsp-remote-host")) return true
  return findServerBinary(name, searchRootForBuffer(buffer)) != null
}
