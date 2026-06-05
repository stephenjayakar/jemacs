import type { Editor } from "../kernel/editor"
import { gruvboxDarkHardTheme } from "../themes"
import { install as installVertico } from "../../plugins/vertico"

/** Personal Jemacs preferences (line numbers, extra keymaps, etc.). */
export function installUserConfig(editor: Editor): void {
  editor.setTheme(gruvboxDarkHardTheme)
  installVertico(editor)
  editor.enableMinorMode("linum-mode")
  editor.enableMinorMode("vertico-mode")
}
