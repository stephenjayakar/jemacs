import type { Editor, KeyDispatchResult } from "../src/kernel/editor"
import { isPrintable, type KeyEventLike } from "../src/kernel/keymap"
import { createPluginContext, type PluginContext } from "../src/runtime/plugin-context"

/** isearch per-key UI loop (DESIGN.md: kernel keeps findForward/findBackward only). */
async function handleIsearchKey(editor: Editor, key: KeyEventLike): Promise<KeyDispatchResult | null> {
  const state = editor.isearch
  if (state && key.ctrl && !key.meta && key.name === "w") {
    const buffer = editor.buffers.get(state.bufferId)
    if (buffer) {
      const from = buffer.point + state.string.length
      const m = /^\W?\w*/.exec(buffer.text.slice(from))
      if (m && m[0]) editor.setIsearchString(state.string + m[0])
    }
    return { status: "inserted" }
  }
  switch (key.name) {
    case "backspace":
      if (editor.isearch) editor.setIsearchString(editor.isearch.string.slice(0, -1))
      return { status: "inserted" }
    case "enter":
    case "return":
      editor.endIsearch()
      return { status: "inserted" }
    case "delete":
      return { status: "inserted" }
    default:
      if (key.meta && (key.name === "p" || key.name === "n")) {
        const ring = editor.searchRing
        if (!ring.length) { editor.message("No previous search string"); return { status: "inserted" } }
        const cur = ring.indexOf(editor.isearch?.string ?? "")
        const i = key.name === "p"
          ? (cur < 0 ? ring.length - 1 : Math.max(0, cur - 1))
          : (cur < 0 ? 0 : Math.min(ring.length - 1, cur + 1))
        editor.setIsearchString(ring[i]!)
        return { status: "inserted" }
      }
      if (isPrintable(key)) {
        const text = (key.sequence ?? "").repeat(editor.prefixArg.consume() ?? 1)
        if (editor.isearch) editor.setIsearchString(editor.isearch.string + text)
        return { status: "inserted" }
      }
  }
  return null
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  editor.isearchKeyHandler = (key) => handleIsearchKey(editor, key)
  ctx.onDispose(() => { if (editor.isearchKeyHandler) editor.isearchKeyHandler = null })

  editor.command("isearch-forward", ({ editor }) => {
    if (editor.isearch?.direction === 1) editor.isearchRepeat()
    else editor.startIsearch(1)
  }, "Incremental search forward.")

  editor.command("isearch-backward", ({ editor }) => {
    if (editor.isearch?.direction === -1) editor.isearchRepeat()
    else editor.startIsearch(-1)
  }, "Incremental search backward.")

  editor.key("C-s", "isearch-forward")
  editor.key("C-r", "isearch-backward")
}
