import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import type { Editor } from "../kernel/editor"
import type { Evaluator } from "../runtime/evaluator"
import { addToLoadPath } from "../runtime/load-path"
import { installCoreCommands } from "../core/commands"
import { installLinumMode } from "../modes/linum-mode"
import { installMinorModeCommands } from "../modes/minor-mode"
import { bindDefaultKeybindings } from "./default-bindings"
import { installUserConfig } from "./user"
import { installDefaultCustomVariables } from "./custom-init"

export { installDefaultHooks, installLspDeferredHooks } from "./install-hooks"
export { LSP_AUTO_MODES, LSP_AUTO_EXTENSIONS, shouldAutoStartLsp } from "./lsp-auto-modes"

/** Load built-in commands and default keybindings (same mechanism as user config). */
export function installDefaultConfig(editor: Editor): Evaluator {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..")
  addToLoadPath(root)
  addToLoadPath(join(homedir(), ".jemacs"))
  const evaluator = installCoreCommands(editor)
  installLinumMode()
  installMinorModeCommands(editor)
  bindDefaultKeybindings(editor)
  installDefaultCustomVariables(editor)
  installUserConfig(editor)
  return evaluator
}

/** @deprecated Use `installDefaultConfig`; kept for reload hooks and older plugins. */
export function installDefaultCommands(editor: Editor): Evaluator {
  return installDefaultConfig(editor)
}

export { installUserConfig } from "./user"
