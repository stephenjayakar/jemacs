import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import { defcustom, getCustom } from "../../src/runtime/custom"

const OPENERS = "([{"
const CLOSERS = ")]}"
const PARTNER: Record<string, string> = {
  "(": ")", ")": "(",
  "[": "]", "]": "[",
  "{": "}", "}": "{",
}

export const SHOW_PAREN_LOCAL = "show-paren-data"

/** Mirrors the Emacs `show-paren-data-function` 5-tuple. */
export type ShowParenData = {
  hereBeg: number
  hereEnd: number
  thereBeg: number | null
  thereEnd: number | null
  mismatch: boolean
}

type Located = { dir: 1 | -1; outside: number }

function categorize(text: string, pos: number): Located | null {
  if (pos < 0 || pos >= text.length) return null
  const ch = text[pos]!
  if (OPENERS.includes(ch)) return { dir: 1, outside: pos }
  if (CLOSERS.includes(ch)) return { dir: -1, outside: pos + 1 }
  return null
}

function locateNearParen(text: string, point: number, insideToo: boolean): Located | null {
  const before = categorize(text, point - 1)
  const after = categorize(text, point)
  if (before?.dir === -1) return before
  if (after?.dir === 1) return after
  if (insideToo && before) return before
  if (insideToo && after) return after
  return null
}

function scanSexp(text: string, outside: number, dir: 1 | -1): number | null {
  let depth = 0
  if (dir === 1) {
    for (let i = outside; i < text.length; i++) {
      const ch = text[i]!
      if (OPENERS.includes(ch)) depth++
      else if (CLOSERS.includes(ch)) {
        depth--
        if (depth === 0) return i + 1
        if (depth < 0) return null
      }
    }
    return null
  }
  for (let i = outside - 1; i >= 0; i--) {
    const ch = text[i]!
    if (CLOSERS.includes(ch)) depth++
    else if (OPENERS.includes(ch)) {
      depth--
      if (depth === 0) return i
      if (depth < 0) return null
    }
  }
  return null
}

export function showParenCompute(
  text: string,
  point: number,
  options: { whenPointInsideParen?: boolean } = {},
): ShowParenData | null {
  const located = locateNearParen(text, point, options.whenPointInsideParen ?? false)
  if (!located) return null
  const { dir, outside } = located
  const hereBeg = dir === 1 ? outside : outside - 1
  const hereEnd = dir === 1 ? outside + 1 : outside
  const pos = scanSexp(text, outside, dir)
  if (pos == null) {
    return { hereBeg, hereEnd, thereBeg: null, thereEnd: null, mismatch: true }
  }
  const thereBeg = dir === 1 ? pos - 1 : pos
  const thereEnd = dir === 1 ? pos : pos + 1
  const hereCh = text[hereBeg]!
  const thereCh = text[thereBeg]!
  const mismatch = PARTNER[hereCh] !== thereCh
  return { hereBeg, hereEnd, thereBeg, thereEnd, mismatch }
}

export function showParenData(buffer: BufferModel): ShowParenData | null {
  return (buffer.locals.get(SHOW_PAREN_LOCAL) as ShowParenData | undefined) ?? null
}

function refresh(editor: Editor): void {
  const buffer = editor.currentBuffer
  if (!editor.isMinorModeEnabled("show-paren-mode", buffer)) {
    buffer.locals.delete(SHOW_PAREN_LOCAL)
    return
  }
  const insideToo = getCustom<boolean>("show-paren-when-point-inside-paren") ?? false
  const data = showParenCompute(buffer.text, buffer.point, { whenPointInsideParen: insideToo })
  if (data) buffer.locals.set(SHOW_PAREN_LOCAL, data)
  else buffer.locals.delete(SHOW_PAREN_LOCAL)
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defcustom("show-paren-when-point-inside-paren", "boolean", false,
    "If non-nil, show parens when point is just inside one.")

  ctx.minorMode({
    name: "show-paren-mode",
    lighter: "",
    global: true,
    onEnable: ed => refresh(ed),
    onDisable: ed => {
      for (const buf of ed.buffers.values()) buf.locals.delete(SHOW_PAREN_LOCAL)
    },
  })

  editor.command("show-paren-mode", ({ editor, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument > 0) editor.enableMinorMode("show-paren-mode")
    else if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode("show-paren-mode")
    else editor.toggleMinorMode("show-paren-mode")
  }, "Toggle visualization of matching parens.")

  editor.events.on("changed", () => refresh(editor))
}
