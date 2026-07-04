import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import type { TextSpan } from "../../src/modes/mode"
import { listWindowLeaves, type WindowId } from "../../src/kernel/window"
import { visibleTextRegionFromStart, pageScrollLines } from "../../src/display/viewport"
import { readKey } from "../../src/core/emacs-standard"

/** Home-row label alphabet (Emacs avy default `avy-keys`). */
export const AVY_KEYS = ["a", "s", "d", "f", "g", "h", "j", "k", "l"] as const

export const AVY_OVERLAYS_LOCAL = "avy-overlays"

export type AvyTarget = { windowId: WindowId; bufferId: string; point: number }

/** Assign prefix-free 1- or 2-key labels to `n` targets. Single keys cover the
 *  first hits; once `n > k` the tail keys become prefixes for `k`-ary leaves. */
export function avyLabels(n: number, keys: readonly string[] = AVY_KEYS): string[] {
  const k = keys.length
  if (n <= k) return keys.slice(0, n)
  // leaves + prefixes·k ≥ n with leaves = k − prefixes  ⇒  prefixes ≥ (n−k)/(k−1)
  const prefixes = Math.min(k, Math.ceil((n - k) / (k - 1)))
  const out = keys.slice(0, k - prefixes)
  outer: for (let i = k - prefixes; i < k; i++) {
    for (let j = 0; j < k; j++) {
      out.push(keys[i]! + keys[j]!)
      if (out.length === n) break outer
    }
  }
  return out
}

/** Every occurrence of `ch` in each window's currently visible region. Uses the
 *  same `visibleTextRegionFromStart` slice the display layer renders from. */
export function avyCollect(editor: Editor, ch: string, lineBudget = pageScrollLines()): AvyTarget[] {
  const out: AvyTarget[] = []
  for (const leaf of listWindowLeaves(editor.windowLayout)) {
    const buffer = editor.buffers.get(leaf.bufferId)
    if (!buffer) continue
    const { visible, visibleStart } = visibleTextRegionFromStart(buffer.text, leaf.startLine, lineBudget, buffer.lineStarts)
    let i = visible.indexOf(ch)
    while (i !== -1) {
      out.push({ windowId: leaf.id, bufferId: buffer.id, point: visibleStart + i })
      i = visible.indexOf(ch, i + 1)
    }
  }
  return out
}

export function avyCollectPair(editor: Editor, pair: string, lineBudget = pageScrollLines()): AvyTarget[] {
  const out: AvyTarget[] = []
  if (pair.length !== 2) return out
  for (const leaf of listWindowLeaves(editor.windowLayout)) {
    const buffer = editor.buffers.get(leaf.bufferId)
    if (!buffer) continue
    const { visible, visibleStart } = visibleTextRegionFromStart(buffer.text, leaf.startLine, lineBudget, buffer.lineStarts)
    let i = visible.indexOf(pair)
    while (i !== -1) {
      out.push({ windowId: leaf.id, bufferId: buffer.id, point: visibleStart + i })
      i = visible.indexOf(pair, i + 1)
    }
  }
  return out
}

function isWordChar(ch: string | undefined): boolean {
  return ch != null && /^[A-Za-z0-9_]$/.test(ch)
}

export function avyCollectWord1(editor: Editor, ch: string, lineBudget = pageScrollLines()): AvyTarget[] {
  const out: AvyTarget[] = []
  if (ch.length !== 1 || !isWordChar(ch)) return out
  for (const leaf of listWindowLeaves(editor.windowLayout)) {
    const buffer = editor.buffers.get(leaf.bufferId)
    if (!buffer) continue
    const { visible, visibleStart } = visibleTextRegionFromStart(buffer.text, leaf.startLine, lineBudget, buffer.lineStarts)
    for (let i = 0; i < visible.length; i++) {
      const point = visibleStart + i
      if (visible[i] === ch && !isWordChar(buffer.text[point - 1])) {
        out.push({ windowId: leaf.id, bufferId: buffer.id, point })
      }
    }
  }
  return out
}

export function avyCollectLine(editor: Editor, lineBudget = pageScrollLines()): AvyTarget[] {
  const out: AvyTarget[] = []
  for (const leaf of listWindowLeaves(editor.windowLayout)) {
    const buffer = editor.buffers.get(leaf.bufferId)
    if (!buffer) continue
    const startLine = Math.max(0, Math.min(leaf.startLine, Math.max(0, buffer.lineCount - lineBudget)))
    const endLine = Math.min(buffer.lineCount, startLine + lineBudget)
    for (let line = startLine; line < endLine; line++) {
      out.push({ windowId: leaf.id, bufferId: buffer.id, point: buffer.lineStarts[line]! })
    }
  }
  return out
}

export function avySpans(buffer: BufferModel): TextSpan[] {
  return (buffer.locals.get(AVY_OVERLAYS_LOCAL) as TextSpan[] | undefined) ?? []
}

type Saved = { buffer: BufferModel; text: string; point: number; dirty: boolean }

/** Overwrite each target's char(s) with its label glyph in-place. Same length,
 *  no dirty/undo, and never crosses a newline so the viewport doesn't reflow. */
function paint(editor: Editor, targets: AvyTarget[], labels: string[]): Saved[] {
  const byBuffer = new Map<string, Array<{ point: number; label: string }>>()
  targets.forEach((t, i) => {
    const list = byBuffer.get(t.bufferId) ?? []
    list.push({ point: t.point, label: labels[i]! })
    byBuffer.set(t.bufferId, list)
  })
  const saved: Saved[] = []
  for (const [bufferId, sites] of byBuffer) {
    const buffer = editor.buffers.get(bufferId)!
    const text = buffer.text
    saved.push({ buffer, text, point: buffer.point, dirty: buffer.dirty })
    const chars = text.split("")
    const spans: TextSpan[] = []
    for (const { point, label } of sites) {
      let end = point
      for (let k = 0; k < label.length; k++) {
        if (end >= chars.length || chars[end] === "\n") break
        chars[end++] = label[k]!
      }
      spans.push({ start: point, end, face: "isearch" })
    }
    buffer.locals.set(AVY_OVERLAYS_LOCAL, spans)
    buffer.setText(chars.join(""), false, false)
    buffer.point = saved.at(-1)!.point
  }
  return saved
}

function restore(saved: Saved[]): void {
  for (const { buffer, text, point, dirty } of saved) {
    buffer.locals.delete(AVY_OVERLAYS_LOCAL)
    buffer.setText(text, false, false)
    buffer.point = point
    buffer.dirty = dirty
  }
}

function jump(editor: Editor, t: AvyTarget): void {
  if (t.windowId !== editor.selectedWindowId) editor.selectWindow(t.windowId)
  editor.currentBuffer.point = t.point
}

async function selectTarget(editor: Editor, targets: AvyTarget[]): Promise<void> {
  if (targets.length === 1) {
    jump(editor, targets[0]!)
    editor.message("")
    return
  }

  const labels = avyLabels(targets.length)
  const saved = paint(editor, targets, labels)
  void editor.changed("avy")
  let chosen: AvyTarget | undefined
  try {
    let typed = ""
    for (;;) {
      const key = await readKey(editor, `avy: ${typed}`)
      if (key == null || key.length !== 1) break
      typed += key
      const hit = labels.indexOf(typed)
      if (hit !== -1) { chosen = targets[hit]; break }
      if (!labels.some(l => l.startsWith(typed))) {
        editor.message(`No such candidate: ${typed}`)
        break
      }
    }
  } finally {
    restore(saved)
    void editor.changed("avy")
  }
  if (chosen) {
    jump(editor, chosen)
    editor.message("")
  }
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  editor.addOverlaySource(avySpans)

  editor.command("avy-goto-char", async ({ editor }) => {
    const ch = await readKey(editor, "char: ")
    if (ch == null || ch.length !== 1) return editor.message("")
    const targets = avyCollect(editor, ch)
    if (!targets.length) return editor.message(`No candidates for '${ch}'`)
    await selectTarget(editor, targets)
  }, "Read a char, label every visible match, then jump to the chosen label.")

  editor.command("avy-goto-char-2", async ({ editor }) => {
    const first = await readKey(editor, "char 1: ")
    if (first == null || first.length !== 1) return editor.message("")
    const second = await readKey(editor, "char 2: ")
    if (second == null || second.length !== 1) return editor.message("")
    const pair = first + second
    const targets = avyCollectPair(editor, pair)
    if (!targets.length) return editor.message(`No candidates for '${pair}'`)
    await selectTarget(editor, targets)
  }, "Read two chars, label every visible pair match, then jump to the chosen label.")

  editor.command("avy-goto-word-1", async ({ editor }) => {
    const ch = await readKey(editor, "char: ")
    if (ch == null || ch.length !== 1) return editor.message("")
    const targets = avyCollectWord1(editor, ch)
    if (!targets.length) return editor.message(`No candidates for '${ch}'`)
    await selectTarget(editor, targets)
  }, "Read a char, label visible word beginnings that start with it, then jump.")

  editor.command("avy-goto-line", async ({ editor }) => {
    const targets = avyCollectLine(editor)
    if (!targets.length) return editor.message("No candidates")
    await selectTarget(editor, targets)
  }, "Label the beginning of each visible line, then jump to the chosen label.")

  editor.key("C-;", "avy-goto-char")
}
