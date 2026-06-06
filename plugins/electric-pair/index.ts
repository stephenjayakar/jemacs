import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import { getTrackedAdvice } from "../../src/runtime/advice"

const OPENERS: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  '"': '"',
  "'": "'",
  "`": "`",
}

const CLOSERS = new Set([")", "]", "}", '"', "'", "`"])

function postSelfInsert(editor: Editor, buffer: BufferModel): void {
  if (!editor.isMinorModeEnabled("electric-pair-mode", buffer)) return
  const ch = editor.lastKeyEvent?.sequence
  if (!ch || ch.length !== 1) return
  if (buffer.text[buffer.point - 1] !== ch) return

  const after = buffer.text[buffer.point]

  if (CLOSERS.has(ch) && after === ch) {
    buffer.deleteRange(buffer.point - 1, buffer.point)
    buffer.amalgamateUndo()
    buffer.point += 1
    return
  }

  const closer = OPENERS[ch]
  if (closer) {
    // electric-pair-conservative-inhibit: don't pair before a word char,
    // and don't pair a quote right after one (apostrophes).
    if (after !== undefined && /\w/.test(after)) return
    if (closer === ch) {
      const before = buffer.text[buffer.point - 2]
      if (before !== undefined && /\w/.test(before)) return
    }
    const between = buffer.point
    buffer.insert(closer)
    buffer.amalgamateUndo()
    buffer.point = between
  }
}

let adviceId: string | undefined

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  ctx.minorMode({ name: "electric-pair-mode", global: true, lighter: " ElP" })

  editor.command("electric-pair-mode", ({ editor, buffer, prefixArgument }) => {
    if (prefixArgument === 1) editor.enableMinorMode("electric-pair-mode", { buffer })
    else if (prefixArgument === 0 || prefixArgument === -1) editor.disableMinorMode("electric-pair-mode", { buffer })
    else editor.toggleMinorMode("electric-pair-mode", { buffer })
  }, "Toggle automatic insertion of matching delimiters.")

  // ctx.advice handles disposal on reload; the id guard remains so test
  // helpers that don't dispose (makeEditor) still avoid stacking on
  // self-insert-command across files.
  if (adviceId === undefined || getTrackedAdvice(adviceId) === undefined) {
    adviceId = ctx.advice("self-insert-command", {
      after: ({ editor, buffer }) => postSelfInsert(editor, buffer),
    })
    ctx.onDispose(() => { adviceId = undefined })
  }
}
