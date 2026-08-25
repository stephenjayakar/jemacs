import { dirname, resolve } from "node:path"
import { stat } from "node:fs/promises"

const rootMarkers = [
  ".git",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "package.json",
  "go.mod",
  "Cargo.toml",
]

/**
 * Roots that can be recognised from the path alone, no filesystem access.
 *
 * Some source trees are deep and network-mounted, so walking parents and stat-ing eight
 * marker files at each level is slow enough to be felt on every LSP request. When the
 * root is unambiguous from the path text, a host or plugin registers a pattern here and
 * skips the walk. Core ships no patterns; see `addPathOnlyRoot`.
 *
 * Each pattern must capture the root directory in group 1.
 */
const pathOnlyRoots = new Map<string, RegExp>()

/**
 * Register a path-only root pattern. Returns a disposer, so a plugin can drop its
 * pattern on hot reload.
 *
 * The pattern runs against an absolute, resolved path and must capture the root in
 * group 1. Example: `/^(.*\/monorepo)(\/|$)/`.
 *
 * Keyed by source text, so re-running a plugin's `install` replaces its pattern rather
 * than stacking a duplicate.
 */
export function addPathOnlyRoot(pattern: RegExp): () => void {
  const key = pattern.source
  pathOnlyRoots.set(key, pattern)
  return () => { pathOnlyRoots.delete(key) }
}

/** Root derivable from the path text alone, or null when a filesystem walk is needed. */
export function fastProjectRoot(filePath: string): string | null {
  const path = resolve(filePath)
  for (const pattern of pathOnlyRoots.values()) {
    const match = pattern.exec(path)
    if (match) return match[1]!
  }
  return null
}

/** Simplified `lsp-workspace-root` / projectile-style root discovery. */
export async function findProjectRoot(filePath: string): Promise<string> {
  const fast = fastProjectRoot(filePath)
  if (fast) return fast
  let dir = dirname(resolve(filePath))
  const root = resolve("/")
  while (dir !== root) {
    for (const marker of rootMarkers) {
      try {
        await stat(resolve(dir, marker))
        return dir
      } catch {
        // continue
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirname(resolve(filePath))
}
