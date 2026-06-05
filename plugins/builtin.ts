import type { Editor } from "../src/kernel/editor"

/**
 * Explicit, ordered load list. Order matters: state providers first
 * (mark-ring, persist), then editing primitives, then UI, then LSP.
 */
const builtins: Array<[name: string, load: () => Promise<{ install: (e: Editor) => void | Promise<void> }>]> = [
  ["motion", () => import("./motion")],
  ["mark-ring", () => import("./mark-ring")],
  ["save-hooks", () => import("./save-hooks")],
  ["comment-dwim", () => import("./comment-dwim")],
  ["subword", () => import("./subword")],
  ["electric-pair", () => import("./electric-pair")],
  ["show-paren", () => import("./show-paren")],
  ["isearch-regexp", () => import("./isearch-regexp")],
  ["windmove", () => import("./windmove")],
  ["next-error", () => import("./next-error")],
  ["flymake-nav", () => import("./flymake-nav")],
  ["fido", () => import("./fido")],
  ["persist", () => import("./persist")],
  ["auto-revert", () => import("./auto-revert")],
  ["auto-save", () => import("./auto-save")],
  ["lsp-extras", () => import("./lsp-extras")],
  ["lsp-monorepo", () => import("./lsp-monorepo")],
  ["lsp-watchman", () => import("./lsp-watchman")],
  ["which-key", () => import("./which-key")],
  ["eldoc", () => import("./eldoc")],
  ["project", () => import("./project")],
  ["compile", () => import("./compile")],
  ["completion-preview", () => import("./completion-preview")],
  ["magit", () => import("./magit")],
  ["dogfood", () => import("./dogfood")],
  ["term", () => import("./term")],
  ["wdired", () => import("./wdired")],
  ["smerge", () => import("./smerge")],
  ["osc52", () => import("./osc52")],
  ["term-v2", () => import("./term-v2")],
  ["avy", () => import("./avy")],
  ["org", () => import("./org")],
  ["lean4", () => import("./lean4")],
]

export async function installBuiltinPlugins(editor: Editor): Promise<void> {
  for (const [name, load] of builtins) {
    try {
      const mod = await load()
      await mod.install(editor)
    } catch (err) {
      editor.message(`plugin ${name} failed: ${(err as Error).message}`)
      console.error(`[plugins/builtin] ${name}:`, err)
    }
  }
}
