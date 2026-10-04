import type { Editor } from "../kernel/editor"
import { modeLineage } from "../modes/mode"
import { defvar } from "./custom"

/**
 * Emacs's `yank-media-handler`: a major mode registers a handler for MIME
 * types matching a pattern, and pasting clipboard media (a GUI image paste)
 * runs the one for the current buffer's mode. Derived modes inherit their
 * parent's handlers, so one `markdown` handler serves gfm and the view modes.
 */
export type YankMediaHandler = (editor: Editor, mime: string, data: Uint8Array) => void | Promise<void>

type Entry = { mode: string; types: RegExp; handler: YankMediaHandler }

function registry(): Entry[] {
  return defvar<Entry[]>("yank-media--registered-handlers", [], "Registered yank-media handlers, newest first.").value
}

/** Register HANDLER for MODE and MIME types matching TYPES. Returns a disposer. */
export function yankMediaHandler(mode: string, types: RegExp, handler: YankMediaHandler): () => void {
  const entry: Entry = { mode, types, handler }
  registry().unshift(entry)
  return () => {
    const entries = registry()
    const i = entries.indexOf(entry)
    if (i >= 0) entries.splice(i, 1)
  }
}

/** The handler for MIME in MODE, the most specific mode first. */
export function yankMediaHandlerFor(mode: string, mime: string): YankMediaHandler | undefined {
  const entries = registry()
  for (const { name } of modeLineage(mode)) {
    const entry = entries.find(e => e.mode === name && e.types.test(mime))
    if (entry) return entry.handler
  }
  return undefined
}

/** Insert clipboard media into the active buffer. False when its mode has no handler. */
export async function yankMedia(editor: Editor, mime: string, data: Uint8Array): Promise<boolean> {
  const buffer = editor.activeBuffer
  const handler = yankMediaHandlerFor(buffer.mode, mime)
  if (!handler) {
    editor.message(`No handler in the current buffer for ${mime}`)
    return false
  }
  if (buffer.readOnly) {
    editor.message(`Buffer is read-only: ${buffer.name}`)
    return false
  }
  await handler(editor, mime, data)
  return true
}
