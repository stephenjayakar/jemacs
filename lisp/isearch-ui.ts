import type { Editor, KeyDispatchResult } from "../src/kernel/editor"
import { isPrintable, type KeyEventLike } from "../src/kernel/keymap"
import { currentKill } from "../src/runtime/kill-ring"
import { createPluginContext, type PluginContext } from "../src/runtime/plugin-context"

/** isearch per-key UI loop (DESIGN.md: kernel keeps findForward/findBackward only). */
async function handleIsearchKey(editor: Editor, key: KeyEventLike): Promise<KeyDispatchResult | null> {
  const state = editor.isearch
  if (state && key.ctrl && !key.meta && key.name === "g") {
    await editor.run("isearch-abort", [], key)
    return { status: "command", command: "isearch-abort" }
  }
  // isearch-mode-map overrides local maps, so C-s/C-r repeat even where the
  // minibuffer (fido, vertico) binds them to candidate movement.
  if (state && key.ctrl && !key.meta && (key.name === "s" || key.name === "r")) {
    const base = key.name === "s" ? "isearch-forward" : "isearch-backward"
    const command = state.regexp && editor.commands.get(`${base}-regexp`) ? `${base}-regexp` : base
    await editor.run(command, [], key)
    return { status: "command", command }
  }
  if (state && key.ctrl && !key.meta && key.name === "w") {
    const buffer = editor.buffers.get(state.bufferId)
    if (buffer) {
      const from = state.match?.end ?? buffer.point
      const m = /^\W?\w*/.exec(buffer.text.slice(from))
      if (m && m[0]) editor.setIsearchString(state.string + m[0])
    }
    return { status: "inserted" }
  }
  if (state && key.ctrl && !key.meta && key.name === "y") {
    const text = currentKill(editor)
    if (text) editor.setIsearchString(state.string + text)
    else editor.message("Kill ring is empty")
    return { status: "inserted" }
  }
  switch (key.name) {
    case "backspace":
      if (editor.isearch) editor.setIsearchString(editor.isearch.string.slice(0, -1))
      return { status: "inserted" }
    case "enter":
    case "return":
      editor.endIsearch()
      editor.clearMessage()
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

  function isearch(direction: 1 | -1): void {
    if (!editor.isearch) return editor.startIsearch(direction)
    editor.isearch.direction = direction
    editor.isearchRepeat()
  }

  editor.command("isearch-forward", () => isearch(1), "Incremental search forward.")
  editor.command("isearch-backward", () => isearch(-1), "Incremental search backward.")

  editor.command("isearch-abort", ({ editor }) => {
    const state = editor.isearch
    if (!state) return
    if (state.string && !state.match) {
      // Failing search: discard the unmatched tail instead of quitting.
      let string = state.string
      while (string && editor.isearch && !editor.isearch.match) {
        string = string.slice(0, -1)
        editor.setIsearchString(string)
      }
      return
    }
    editor.cancelIsearch()
    editor.message("Quit")
  }, "Abort incremental search: drop the failing part, else cancel and restore point (and minibuffer input).")

  editor.key("C-s", "isearch-forward")
  editor.key("C-r", "isearch-backward")
}
