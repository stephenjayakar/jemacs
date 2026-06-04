import type { BufferModel } from "../kernel/buffer"
import { inferMode } from "../kernel/buffer"

/** Modes with lsp-deferred hooks in ~/.emacs.d/stephen.el. */
export const LSP_AUTO_MODES = new Set([
  "python",
  "javascript",
  "typescript",
  "go",
  "rust",
  "yaml",
])

/** File extensions that map to LSP-backed modes (via `inferMode`). */
export const LSP_AUTO_EXTENSIONS = /\.(py|pyi|pyw|js|mjs|cjs|jsx|ts|mts|cts|tsx|go|rs|ya?ml)$/i

export function shouldAutoStartLsp(buffer: BufferModel): boolean {
  if (!buffer.path || buffer.kind !== "file") return false
  if (LSP_AUTO_MODES.has(buffer.mode)) return true
  return LSP_AUTO_EXTENSIONS.test(buffer.path) || LSP_AUTO_EXTENSIONS.test(buffer.name)
}

export function lspModeForPath(path: string): string | null {
  const mode = inferMode(path)
  return LSP_AUTO_MODES.has(mode) ? mode : null
}
