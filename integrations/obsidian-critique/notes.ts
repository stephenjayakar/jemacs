import { type Extension } from "@codemirror/state"
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view"
import { editorLivePreviewField, type MarkdownPostProcessorContext } from "obsidian"
import {
  critiqueHiddenRanges,
  formatCritiqueComment,
  parseCritiqueComments,
  type CritiqueComment,
} from "../../plugins/critique/parse"

export type CritiqueChange = { kind: "edit" | "reply"; text: string } | { kind: "resolve" }

/** The edit that applies `change` to `c` in `text`: `edit` replaces the comment,
 *  `resolve` drops it (keeping the highlighted text), `reply` adds another
 *  comment right after it, the same markup jemacs' `critique-reply-comment`
 *  writes. Re-parses so stale offsets from an old render can't clobber an edit;
 *  null when `c` is no longer there. */
export function critiqueEdit(text: string, c: CritiqueComment, change: CritiqueChange): { from: number; to: number; insert: string } | null {
  const fresh = parseCritiqueComments(text).find(x => x.start === c.start && x.end === c.end)
  if (!fresh) return null
  const insert = change.kind === "resolve" ? fresh.quote
    : change.kind === "edit" ? formatCritiqueComment(fresh.quote || null, change.text, fresh.syntax)
    : text.slice(fresh.start, fresh.end) + formatCritiqueComment(null, change.text, fresh.syntax)
  return { from: fresh.start, to: fresh.end, insert }
}

/** Prompts for comment text (the plugin's modal). */
export type NoteHost = {
  ask(heading: string, initial: string, onSubmit: (text: string) => void): void
}

/** A margin note like jemacs' critique-mode draws: click the text to edit,
 *  √ resolves, + replies. Floats into the right margin under `.critique-margin`,
 *  otherwise sits inline. */
export function renderNote(c: CritiqueComment, active: boolean, host: NoteHost, apply: (change: CritiqueChange) => void): HTMLElement {
  const note = createSpan({ cls: active ? "critique-note is-active" : "critique-note" })
  const text = note.createSpan({ cls: "critique-note-text", text: c.text || "(empty)" })
  text.setAttribute("aria-label", "Edit comment")
  text.addEventListener("click", evt => {
    evt.preventDefault()
    evt.stopPropagation()
    host.ask("Edit comment", c.text, value => apply({ kind: "edit", text: value }))
  })
  const actions = note.createSpan({ cls: "critique-note-actions" })
  const button = (label: string, title: string, onClick: () => void) => {
    const b = actions.createSpan({ cls: "critique-note-button", text: label })
    b.setAttribute("aria-label", title)
    b.addEventListener("click", evt => {
      evt.preventDefault()
      evt.stopPropagation()
      onClick()
    })
  }
  button("√", "Resolve", () => apply({ kind: "resolve" }))
  button("+", "Reply", () => host.ask("Reply", "", value => apply({ kind: "reply", text: value })))
  // Keep the editor from moving the cursor or starting a selection here.
  note.addEventListener("mousedown", evt => evt.stopPropagation())
  return note
}

class NoteWidget extends WidgetType {
  constructor(readonly c: CritiqueComment, readonly active: boolean, readonly host: NoteHost) {
    super()
  }

  eq(other: NoteWidget): boolean {
    return other.c.start === this.c.start && other.c.end === this.c.end && other.c.text === this.c.text && other.active === this.active
  }

  toDOM(view: EditorView): HTMLElement {
    return renderNote(this.c, this.active, this.host, change => {
      const edit = critiqueEdit(view.state.doc.toString(), this.c, change)
      if (edit) view.dispatch({ changes: edit })
    })
  }

  ignoreEvent(): boolean {
    return true
  }
}

const highlight = Decoration.mark({ class: "cm-highlight critique-highlight" })
const hidden = Decoration.replace({})

/** Delimiters to hide in Live Preview. Obsidian already hides the `==` of
 *  native highlights, so only the `%%comment%%` goes; CriticMarkup is all ours. */
function hiddenRanges(c: CritiqueComment): Array<[number, number]> {
  if (c.syntax === "critic" || c.highlightEnd == null) return critiqueHiddenRanges(c)
  return [[c.commentStart - 2, c.end]]
}

function decorations(view: EditorView, host: NoteHost): DecorationSet {
  const live = view.state.field(editorLivePreviewField, false) ?? false
  const ranges = view.state.selection.ranges
  const out = []
  for (const c of parseCritiqueComments(view.state.doc.toString())) {
    // Like Obsidian's own markup: show the raw comment while the cursor is in it.
    const active = ranges.some(r => r.from <= c.end && r.to >= c.start)
    out.push(Decoration.widget({ widget: new NoteWidget(c, active, host), side: -1 }).range(c.start))
    if (c.syntax === "critic" && c.highlightStart != null && c.highlightEnd != null && c.highlightEnd > c.highlightStart) {
      out.push(highlight.range(c.highlightStart, c.highlightEnd))
    }
    if (live && !active) for (const [from, to] of hiddenRanges(c)) if (to > from) out.push(hidden.range(from, to))
  }
  return Decoration.set(out, true)
}

/** Margin notes in the editor (Live Preview and source mode). `onLayout` runs
 *  when the editor's geometry changes so the plugin can re-fit the margin. */
export function critiqueEditorExtension(host: NoteHost, onLayout: () => void): Extension {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = decorations(view, host)
    }

    update(u: ViewUpdate): void {
      const live = u.state.field(editorLivePreviewField, false) !== u.startState.field(editorLivePreviewField, false)
      if (u.docChanged || u.selectionSet || live) this.decorations = decorations(u.view, host)
      if (u.geometryChanged) onLayout()
    }
  }, { decorations: v => v.decorations })
}

let parsed: { text: string; comments: CritiqueComment[] } | null = null

/** Every section of a note gets the whole document; parse it once. */
function commentsOf(text: string): CritiqueComment[] {
  if (parsed?.text !== text) parsed = { text, comments: parseCritiqueComments(text) }
  return parsed.comments
}

/** Strip inline markup so a source quote compares equal to its rendered text. */
function normalize(s: string): string {
  return s.replace(/[\s*_`~[\]]/g, "")
}

/** Margin notes in reading view, where Obsidian has already dropped the
 *  `%%comment%%`. Anchored notes go right before their `<mark>`; point comments
 *  (whose position the renderer threw away) at the top of the block. */
export function critiqueReadingProcessor(host: NoteHost, apply: (sourcePath: string, c: CritiqueComment, change: CritiqueChange) => void) {
  return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
    const info = ctx.getSectionInfo(el)
    if (!info) return
    const comments = commentsOf(info.text).filter(c => c.line >= info.lineStart && c.line <= info.lineEnd)
    if (!comments.length) return
    const marks = Array.from(el.querySelectorAll("mark"))
    let next = 0
    const top = el.firstElementChild instanceof HTMLElement ? el.firstElementChild : el
    for (const c of comments) {
      const note = renderNote(c, false, host, change => apply(ctx.sourcePath, c, change))
      let mark: HTMLElement | undefined
      if (c.quote) {
        const want = normalize(c.quote)
        const at = marks.findIndex((m, i) => i >= next && normalize(m.textContent ?? "") === want)
        if (at >= 0) {
          mark = marks[at]
          next = at + 1
        }
      }
      if (mark) mark.before(note)
      else top.prepend(note)
    }
  }
}
