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

/** Simplified `lsp-workspace-root` / projectile-style root discovery. */
export async function findProjectRoot(filePath: string): Promise<string> {
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
