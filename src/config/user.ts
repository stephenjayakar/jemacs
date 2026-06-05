import type { Editor } from "../kernel/editor"
import { gruvboxDarkHardTheme } from "../themes"
import { install as installIvy } from "../../plugins/ivy-mode"

/** Personal Jemacs preferences (line numbers, extra keymaps, etc.). */
export function installUserConfig(editor: Editor): void {
  editor.setTheme(gruvboxDarkHardTheme)
  installIvy(editor)
  editor.enableMinorMode("linum-mode")
  editor.enableMinorMode("ivy-mode")
}
