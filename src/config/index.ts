import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import type { Editor } from "../kernel/editor"
import type { Evaluator } from "../runtime/evaluator"
import { addToLoadPath } from "../runtime/load-path"
import { installLisp } from "../../lisp"
import { installLinumMode } from "../modes/linum-mode"
import { installTextScaleMode } from "../core/text-scale"
import { installMinorModeCommands } from "../modes/minor-mode"
import { installCustomizeCommands } from "../modes/customize"
import { bindDefaultKeybindings } from "./default-bindings"
import { installDefaultCustomVariables } from "./custom-init"
import { installDefaultFaces } from "./faces-init"
import { install as installWindowPlugin } from "../../plugins/window"

export { installDefaultHooks, installLspDeferredHooks } from "./install-hooks"
export { LSP_AUTO_MODES, LSP_AUTO_EXTENSIONS, shouldAutoStartLsp } from "./lsp-auto-modes"

/** Load built-in commands and default keybindings (same mechanism as user config). */
export function installDefaultConfig(editor: Editor): Evaluator {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..")
  addToLoadPath(root)
  addToLoadPath(join(homedir(), ".jemacs"))
  const evaluator = installLisp(editor)
  installLinumMode()
  installTextScaleMode()
  installMinorModeCommands(editor)
  installCustomizeCommands(editor)
  installWindowPlugin(editor)
  bindDefaultKeybindings(editor)
  installDefaultCustomVariables(editor)
  installDefaultFaces()
  return evaluator
}

export { loadCustomFile, saveCustomFile, customFilePath } from "./load-custom"
export { installUserConfig, userConfigPath } from "./user"
