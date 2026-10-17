import type { BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { Keymap } from "../../src/kernel/keymap"
import { modeLineage, type FaceName, type TextSpan } from "../../src/modes/mode"
import { defcustom, defvar, getCustom } from "../../src/runtime/custom"
import { defface } from "../../src/runtime/faces"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { RightMarginClickFn, RightMarginFn, RightMarginSpec } from "../../src/display/right-margin"
import type { MarkdownHideFn, MarkupOp } from "../markdown"
import { parseInlineMarkdown, type InlineMarkdown } from "../markdown/inline"
import {
  critiqueCommentAt,
  critiqueHiddenRanges,
  formatCritiqueComment,
  parseCritiqueComments,
  type CritiqueComment,
  type CritiqueSyntax,
} from "./parse"

export * from "./parse"

export const CRITIQUE_MODE = "critique-mode"
const CACHE_LOCAL = "critique--cache"
const HIDE_LOCAL = "critique-hide-inline-comments"

type Cache = { text: string; comments: CritiqueComment[]; hides: MarkupOp[]; rendered: InlineMarkdown[] }

/** Parse once per buffer text; the `hides` array identity is what keeps the
 *  markdown display-filter cache warm, so only rebuild it when text changes. */
export function critiqueComments(buffer: BufferModel): CritiqueComment[] {
  return cached(buffer).comments
}

function cached(buffer: BufferModel): Cache {
  const hit = buffer.locals.get(CACHE_LOCAL) as Cache | undefined
  if (hit && hit.text === buffer.text) return hit
  const comments = parseCritiqueComments(buffer.text)
  const hides = comments.flatMap(c => critiqueHiddenRanges(c).map(([start, end]) => ({ start, end, display: "" })))
  // Comment text is markdown too: the margin shows it rendered.
  const rendered = comments.map(c => parseInlineMarkdown(c.text))
  const next = { text: buffer.text, comments, hides, rendered }
  buffer.locals.set(CACHE_LOCAL, next)
  return next
}

function hideInline(buffer: BufferModel): boolean {
  const local = buffer.locals.get(HIDE_LOCAL)
  if (typeof local === "boolean") return local
  return getCustom<boolean>(HIDE_LOCAL) ?? true
}

function syntax(): CritiqueSyntax {
  return getCustom<string>("critique-syntax") === "critic" ? "critic" : "obsidian"
}

/** The margin/hide lists are process-global; skip buffers owned by another
 *  Editor so a second editor's install doesn't double-draw notes. */
function enabled(editor: Editor, buffer: BufferModel): boolean {
  return editor.buffers.get(buffer.id) === buffer && editor.isMinorModeEnabled(CRITIQUE_MODE, buffer)
}

function isMarkdown(buffer: BufferModel): boolean {
  return modeLineage(buffer.mode).some(m => m.name === "markdown")
}

function activeRegion(buffer: BufferModel): { start: number; end: number } | null {
  if (!buffer.useRegion()) return null
  return { start: Math.min(buffer.mark!, buffer.point), end: Math.max(buffer.mark!, buffer.point) }
}

function anchorOf(c: CritiqueComment): number {
  return c.highlightStart ?? c.start
}

export function critiqueSpans(editor: Editor, buffer: BufferModel): TextSpan[] {
  if (!enabled(editor, buffer)) return []
  const comments = critiqueComments(buffer)
  if (!comments.length) return []
  const active = critiqueCommentAt(comments, buffer.point)
  const hidden = hideInline(buffer) && isMarkdown(buffer)
  const spans: TextSpan[] = []
  for (const c of comments) {
    if (c.highlightStart != null && c.highlightEnd != null) {
      const face = c === active ? "critique-highlight-active-face" : "critique-highlight-face"
      spans.push({ start: c.highlightStart, end: c.highlightEnd, face: face as FaceName })
    }
    if (!hidden) {
      for (const [start, end] of critiqueHiddenRanges(c)) spans.push({ start, end, face: "comment" })
    }
  }
  return spans
}

export function critiqueMargin(editor: Editor, buffer: BufferModel, point: number): RightMarginSpec | null {
  if (!enabled(editor, buffer)) return null
  const { comments, rendered } = cached(buffer)
  if (!comments.length) return null
  const active = critiqueCommentAt(comments, point)
  return {
    width: getCustom<number>("critique-margin-width") ?? 36,
    notes: comments.map((c, i) => ({
      pos: anchorOf(c),
      text: rendered[i]!.text,
      spans: rendered[i]!.spans,
      face: c === active ? "critique-margin-active-face" : "critique-margin-face",
      // Clicking the text edits it; the √ / + buttons resolve and reply.
      id: String(c.start),
      actions: true,
      // The comment at point shows in full; the rest fold after a few lines.
      expanded: c === active,
    })),
  }
}

export function critiqueHides(editor: Editor, buffer: BufferModel): readonly MarkupOp[] {
  if (!enabled(editor, buffer) || !hideInline(buffer)) return []
  return cached(buffer).hides
}

/** Wrap [start, end) in a highlight + comment, or insert a point comment when
 *  start === end. Leaves point after the construct. */
export function critiqueInsert(buffer: BufferModel, start: number, end: number, comment: string, style = syntax()): void {
  const quote = buffer.text.slice(start, end)
  const markup = formatCritiqueComment(quote || null, comment, style)
  buffer.replaceRange(start, end, markup)
  buffer.point = start + markup.length
  buffer.clearMark()
}

/** Replace the comment text, keeping the highlight and the comment's dialect. */
export function critiqueEdit(buffer: BufferModel, c: CritiqueComment, comment: string): void {
  const markup = formatCritiqueComment(c.quote || null, comment, c.syntax)
  buffer.replaceRange(c.start, c.end, markup)
  buffer.point = c.start + markup.length
}

/** Add another comment right after `c`, as a point comment in `c`'s dialect,
 *  so it stacks under `c` in the margin. Leaves point after the new comment. */
export function critiqueReply(buffer: BufferModel, c: CritiqueComment, comment: string): void {
  const markup = formatCritiqueComment(null, comment, c.syntax)
  buffer.replaceRange(c.end, c.end, markup)
  buffer.point = c.end + markup.length
}

/** Map a margin click to the command that does the same thing from the
 *  keyboard: point goes to the comment, then edit / resolve / reply runs. */
export function critiqueMarginClick(editor: Editor, buffer: BufferModel, note: string, action: string): boolean {
  if (!enabled(editor, buffer)) return false
  const c = critiqueComments(buffer).find(x => String(x.start) === note)
  if (!c) return false
  buffer.clearMark()
  buffer.point = anchorOf(c)
  const command = action === "resolve" ? "critique-resolve-comment"
    : action === "reply" ? "critique-reply-comment"
    : "critique-comment"
  // Not awaited: edit/reply open the minibuffer, which the next keys answer.
  void editor.run(command)
  return true
}

/** Drop the comment, keeping any highlighted text as plain text. */
export function critiqueResolve(buffer: BufferModel, c: CritiqueComment): void {
  buffer.replaceRange(c.start, c.end, c.quote)
  buffer.point = c.start + c.quote.length
}

function gotoComment(editor: Editor, buffer: BufferModel, dir: 1 | -1): void {
  const comments = critiqueComments(buffer)
  const here = critiqueCommentAt(comments, buffer.point)
  const target = dir === 1
    ? comments.find(c => c.start > (here?.end ?? buffer.point))
    : [...comments].reverse().find(c => c.end < (here?.start ?? buffer.point))
  if (!target) {
    editor.message(dir === 1 ? "No next comment" : "No previous comment")
    return
  }
  buffer.point = anchorOf(target)
  editor.message(target.text)
}

function ensureMode(editor: Editor, buffer: BufferModel): void {
  if (!enabled(editor, buffer)) editor.enableMinorMode(CRITIQUE_MODE, { buffer })
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defcustom("critique-syntax", "string", "obsidian",
    "Markup for new comments: \"obsidian\" (==text==%%comment%%) or \"critic\" (CriticMarkup {==text==}{>>comment<<}).")
  defcustom("critique-margin-width", "number", 36, "Width of the right-margin comment column, in cells.")
  defcustom(HIDE_LOCAL, "boolean", true, "Hide comment markup inline in markdown buffers while critique-mode is on.")
  defcustom("critique-auto-enable", "boolean", true, "Turn on critique-mode when visiting a markdown file that has comments.")

  defface("critique-highlight-face", { bg: "#4d4214" }, "Text a critique comment is attached to.")
  defface("critique-highlight-active-face", { bg: "#7a6418" }, "Highlighted text of the comment at point.")
  defface("critique-margin-face", { fg: "#c8b26a", italic: true }, "Critique comments in the right margin.")
  defface("critique-margin-active-face", { fg: "#ffd866", bold: true }, "The comment at point, in the right margin.")

  const keymap = new Keymap(`${CRITIQUE_MODE}-map`)
  keymap.bind("C-c ;", "critique-comment")
  keymap.bind("C-c ]", "critique-next-comment")
  keymap.bind("C-c [", "critique-previous-comment")
  keymap.bind("C-c /", "critique-resolve-comment")
  keymap.bind("C-c =", "critique-reply-comment")
  keymap.bind("C-c C-x ;", "critique-toggle-inline-comments")

  ctx.minorMode({ name: CRITIQUE_MODE, lighter: " Crit", keymap })
  // Reachable before the mode is on; critique-comment enables it.
  ctx.key("markdown-map", "C-c ;", "critique-comment")

  ctx.onDispose(editor.addOverlaySource(buffer => critiqueSpans(editor, buffer)))
  const margin: RightMarginFn = (buffer, point) => critiqueMargin(editor, buffer, point)
  const hides: MarkdownHideFn = buffer => critiqueHides(editor, buffer)
  pushCustom("right-margin-functions", margin, ctx)
  pushCustom("markdown-display-hide-functions", hides, ctx)
  const click: RightMarginClickFn = (buffer, note, action) => critiqueMarginClick(editor, buffer, note, action)
  pushCustom("right-margin-click-functions", click, ctx)

  ctx.hook("find-file-hook", ({ buffer }) => {
    if (getCustom<boolean>("critique-auto-enable") === false) return
    if (isMarkdown(buffer) && critiqueComments(buffer).length) ensureMode(editor, buffer)
  })

  ctx.command(CRITIQUE_MODE, ({ editor, buffer, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument > 0) editor.enableMinorMode(CRITIQUE_MODE, { buffer })
    else if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode(CRITIQUE_MODE, { buffer })
    else editor.toggleMinorMode(CRITIQUE_MODE, { buffer })
  }, "Toggle margin comments on highlighted text (Obsidian/CriticMarkup compatible).")

  ctx.command("critique-comment", async ({ editor, buffer }) => {
    const region = activeRegion(buffer)
    const comments = critiqueComments(buffer)
    if (region) {
      if (buffer.text.slice(region.start, region.end).includes("\n")) {
        editor.message("Critique comments must stay within one line")
        return
      }
      if (comments.some(c => region.start < c.end && region.end > c.start)) {
        editor.message("Region overlaps an existing comment")
        return
      }
    }
    const existing = region ? null : critiqueCommentAt(comments, buffer.point)
    const text = await editor.prompt(existing ? "Edit comment: " : "Comment: ", existing?.text ?? "", "critique-comment")
    if (text == null || !text.trim()) return
    ensureMode(editor, buffer)
    if (existing) critiqueEdit(buffer, existing, text)
    else if (region) critiqueInsert(buffer, region.start, region.end, text)
    else critiqueInsert(buffer, buffer.point, buffer.point, text)
  }, "Comment on the region, edit the comment at point, or add a point comment.")

  ctx.command("critique-reply-comment", async ({ editor, buffer }) => {
    const c = critiqueCommentAt(critiqueComments(buffer), buffer.point)
    if (!c) {
      editor.message("No comment at point")
      return
    }
    const text = await editor.prompt("Reply: ", "", "critique-comment")
    if (text == null || !text.trim()) return
    critiqueReply(buffer, c, text)
  }, "Add another comment after the comment at point; it stacks under it in the margin.")

  ctx.command("critique-resolve-comment", ({ editor, buffer }) => {
    const c = critiqueCommentAt(critiqueComments(buffer), buffer.point)
    if (!c) {
      editor.message("No comment at point")
      return
    }
    critiqueResolve(buffer, c)
    editor.message(`Resolved: ${c.text}`)
  }, "Delete the comment at point, keeping its highlighted text.")

  ctx.command("critique-next-comment", ({ editor, buffer }) => gotoComment(editor, buffer, 1),
    "Move to the next comment.")
  ctx.command("critique-previous-comment", ({ editor, buffer }) => gotoComment(editor, buffer, -1),
    "Move to the previous comment.")

  ctx.command("critique-list-comments", async ({ editor, buffer }) => {
    const comments = critiqueComments(buffer)
    if (!comments.length) {
      editor.message("No comments")
      return
    }
    const labels = comments.map(c => `${c.line + 1}: ${c.quote ? `“${c.quote}” — ` : ""}${c.text}`)
    const pick = await editor.completingRead("Go to comment: ", { collection: labels })
    const i = pick == null ? -1 : labels.indexOf(pick)
    if (i >= 0) buffer.point = anchorOf(comments[i]!)
  }, "Jump to a comment, chosen with completion.")

  ctx.command("critique-toggle-inline-comments", ({ editor, buffer }) => {
    const next = !hideInline(buffer)
    buffer.locals.set(HIDE_LOCAL, next)
    editor.message(next ? "Inline comments hidden" : "Inline comments shown")
  }, "Toggle hiding comment markup in the text (the margin is unaffected).")
}

/** Append `fn` to a list-valued variable and remove it on dispose. */
function pushCustom<T>(name: string, fn: T, ctx: PluginContext): void {
  const list = defvar(name, [] as T[]).value
  list.push(fn)
  ctx.onDispose(() => {
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  })
}
