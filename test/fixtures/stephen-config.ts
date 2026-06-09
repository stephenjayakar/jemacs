import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import type { Editor } from "../../src/kernel/editor"
import { setCustom } from "../../src/runtime/custom"
import { setFaceAttribute } from "../../src/runtime/faces"
import { enableBuiltinTheme } from "../../src/themes"
import { gruvboxDarkHardTheme, install as installGruvboxDarkHardTheme } from "../../plugins/gruvbox-dark-hard"
import { install as installVertico } from "../../plugins/vertico"
import { install as installTiling } from "../../plugins/tiling"
import { install as installWindow } from "../../plugins/window"
import { install as installTreeSitterGrammars } from "../../plugins/tree-sitter-grammars"
import "../../plugins/markdown"

/** Test fixture mirroring Stephen's personal config (see jemacs-stephen-config). */
export async function install(editor: Editor): Promise<void> {
  await installTreeSitterGrammars(editor)
  const userTemporaryFileDirectory = join(tmpdir(), userInfo().username)
  setCustom("backup-directory-alist", [[".", userTemporaryFileDirectory]])
  setCustom("markdown-fontify-code-blocks-natively", true)
  setCustom("markdown-fill-column", 100)
  setCustom("markdown-visual-fill-column-center-text", true)
  setCustom("word-wrap", true)

  installGruvboxDarkHardTheme(editor)
  enableBuiltinTheme(gruvboxDarkHardTheme.name)
  setFaceAttribute("default", "family", "Fira Code")
  setFaceAttribute("default", "height", 140)
  editor.setTheme(gruvboxDarkHardTheme)
  installVertico(editor)
  installWindow(editor)
  installTiling(editor)
  editor.enableMinorMode("linum-mode")
  editor.enableMinorMode("vertico-mode")

  editor.key("C-c t", "xref-find-definitions")
  editor.key("C-c C-t", "lsp-ui-peek-find-implementation")
  editor.key("C-x C-a", "lsp-execute-code-action")
  editor.key("C-x C-j", "previous-buffer")
  editor.key("C-x C-l", "next-buffer")
  editor.key("s-f", "counsel-ag")
  editor.key("s-=", "text-scale-adjust")
}
