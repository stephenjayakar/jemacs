import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import { modeSystem } from "../../src/kernel/extension-points"
import type { ImenuIndexEntry } from "../../src/modes/mode"
import { emacsLispImenuIndex } from "../../src/modes/emacs-lisp"
import { javascriptImenuIndex } from "../../src/modes/generic"
import { pythonImenuIndex } from "../../src/modes/python"
import { shellScriptImenuIndex } from "../../src/modes/shell-script"

type ImenuIndexer = (buffer: BufferModel) => ImenuIndexEntry[]

const fallbackIndexers: Record<string, ImenuIndexer> = {
  python: pythonImenuIndex,
  "emacs-lisp-mode": emacsLispImenuIndex,
  "sh-mode": shellScriptImenuIndex,
  "shell-script-mode": shellScriptImenuIndex,
  "bash-mode": shellScriptImenuIndex,
  javascript: javascriptImenuIndex,
  typescript: javascriptImenuIndex,
}

export function buildImenuIndex(buffer: BufferModel): ImenuIndexEntry[] {
  const indexer = modeSystem.modeFeature(buffer.mode, "imenuIndex") ?? fallbackIndexers[buffer.mode]
  if (!indexer) return []
  return indexer(buffer)
    .filter(entry => entry.name && Number.isFinite(entry.point))
    .sort((a, b) => a.point - b.point || a.name.localeCompare(b.name))
}

export function install(editor: Editor): void {
  editor.command("imenu", async ({ editor, buffer, args }) => {
    const entries = buildImenuIndex(buffer)
    if (!entries.length) {
      editor.message("No items suitable for an index found in this buffer")
      return
    }
    const labels = entries.map(entry => entry.name)
    const choice = args[0] ?? await editor.completingRead("Index item: ", {
      collection: labels,
      history: "imenu",
    })
    if (!choice) return
    const entry = entries.find(candidate => candidate.name === choice)
    if (!entry) {
      editor.message(`No imenu item named ${choice}`)
      return
    }
    buffer.point = Math.max(0, Math.min(buffer.text.length, entry.point))
    await editor.changed("imenu")
  }, "Jump to a definition selected from the current buffer index.")

  editor.key("M-g i", "imenu")
}
