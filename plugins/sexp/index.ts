import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import type { CompletionCandidate } from "../../src/modes/mode"
import { modeFeature } from "../../src/modes/mode"
import { defgeneric, defmethod, GENERIC_DEFAULT_MODE } from "../../src/runtime/generic"

/**
 * Open the closed `Mode` behavior fields (`indentLine`, `completeAtPoint`) to
 * third-party extension via `defmethod`, and introduce `forward-sexp` as a
 * generic so tree-sitter modes can supply structural motion.
 */

export const indentLine = defgeneric<(b: BufferModel) => void>("indent-line", {
  doc: "Indent the current line according to the buffer's major mode.",
})

export const completeAtPoint = defgeneric<(b: BufferModel) => CompletionCandidate[]>("complete-at-point", {
  doc: "Return completion candidates at point for the buffer's major mode.",
  fallback: () => [],
})

export const forwardSexp = defgeneric<(b: BufferModel, n: number) => boolean>("forward-sexp", {
  doc: "Move across one balanced expression. Tree-sitter modes may override.",
})

// Bridge: until callers migrate off Mode fields, the catch-all method consults
// the legacy `Mode.indentLine` / `Mode.completeAtPoint` so existing modes keep
// working while new code can `defmethod` a more specific override.
defmethod("indent-line", GENERIC_DEFAULT_MODE, buffer => {
  const legacy = modeFeature(buffer.mode, "indentLine")
  if (legacy) legacy(buffer)
  else buffer.insert("  ")
})

defmethod("complete-at-point", GENERIC_DEFAULT_MODE, buffer => {
  const legacy = modeFeature(buffer.mode, "completeAtPoint")
  return legacy?.(buffer) ?? []
})

defmethod("forward-sexp", GENERIC_DEFAULT_MODE, (buffer, n) => scanSexpDefault(buffer, n))

const OPENERS = "([{"
const CLOSERS = ")]}"

/** Character-level fallback shared by modes without a tree-sitter parser. */
function scanSexpDefault(buffer: BufferModel, n: number): boolean {
  const dir = n < 0 ? -1 : 1
  let count = Math.abs(n) || 1
  let point = buffer.point
  while (count-- > 0) {
    const next = dir > 0 ? scanForward(buffer.text, point) : scanBackward(buffer.text, point)
    if (next == null) return false
    point = next
  }
  buffer.point = point
  return true
}

function scanForward(text: string, from: number): number | null {
  let i = from
  while (i < text.length && /\s/.test(text[i]!)) i++
  if (i >= text.length) return null
  if (OPENERS.includes(text[i]!)) return matchDelim(text, i, 1)
  if (CLOSERS.includes(text[i]!)) return null
  while (i < text.length && !/\s/.test(text[i]!) && !OPENERS.includes(text[i]!) && !CLOSERS.includes(text[i]!)) i++
  return i
}

function scanBackward(text: string, from: number): number | null {
  let i = from
  while (i > 0 && /\s/.test(text[i - 1]!)) i--
  if (i <= 0) return null
  if (CLOSERS.includes(text[i - 1]!)) return matchDelim(text, i, -1)
  if (OPENERS.includes(text[i - 1]!)) return null
  while (i > 0 && !/\s/.test(text[i - 1]!) && !OPENERS.includes(text[i - 1]!) && !CLOSERS.includes(text[i - 1]!)) i--
  return i
}

function matchDelim(text: string, from: number, dir: 1 | -1): number | null {
  let depth = 0
  let i = from
  for (; dir > 0 ? i < text.length : i > 0; i += dir) {
    const ch = text[dir > 0 ? i : i - 1]!
    if ((dir > 0 ? OPENERS : CLOSERS).includes(ch)) depth++
    else if ((dir > 0 ? CLOSERS : OPENERS).includes(ch)) {
      depth--
      if (depth === 0) return dir > 0 ? i + 1 : i - 1
      if (depth < 0) return null
    }
  }
  return null
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  editor.command("forward-sexp", ({ buffer, editor, prefixArgument }) => {
    if (!forwardSexp(buffer, prefixArgument ?? 1)) {
      editor.message("No next sexp")
    }
  }, "Move forward across one balanced expression (sexp).")

  editor.command("backward-sexp", ({ buffer, editor, prefixArgument }) => {
    if (!forwardSexp(buffer, -(prefixArgument ?? 1))) {
      editor.message("No previous sexp")
    }
  }, "Move backward across one balanced expression (sexp).")

  editor.key("C-M-f", "forward-sexp")
  editor.key("C-M-b", "backward-sexp")
}
