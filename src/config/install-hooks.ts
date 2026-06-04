import type { Editor } from "../kernel/editor"
import { modeHookName } from "../kernel/hooks"
import { LSP_AUTO_MODES } from "./lsp-auto-modes"

/** Emacs-style `lsp-deferred` on mode hooks from ~/.emacs.d/stephen.el. */
export function installLspDeferredHooks(editor: Editor): void {
  const lspDeferred = ({ editor: ed, buffer }: { editor: Editor; buffer: import("../kernel/buffer").BufferModel }) => {
    void ed.lsp?.maybeAutoStart(buffer)
  }
  for (const mode of LSP_AUTO_MODES) {
    editor.addHook(modeHookName(mode), lspDeferred)
  }
}

export function installDefaultHooks(editor: Editor): void {
  installLspDeferredHooks(editor)
}
