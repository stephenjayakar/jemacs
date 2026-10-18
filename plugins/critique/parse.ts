/**
 * Comment syntax shared by the jemacs `critique-mode` plugin and the
 * Obsidian viewer (`integrations/obsidian-critique`). Pure — no jemacs or
 * Obsidian imports — so both sides bundle the same parser.
 *
 * Two dialects, both single-line:
 *
 *   obsidian  ==highlighted text==%%comment%%   (native Obsidian: the highlight
 *             %%comment%%                        renders, the comment is hidden
 *                                                in reading view)
 *   critic    {==highlighted text==}{>>comment<<}   (CriticMarkup)
 *             {>>comment<<}
 */

export type CritiqueSyntax = "obsidian" | "critic"

export type CritiqueComment = {
  /** Whole construct, delimiters included. */
  start: number
  end: number
  /** Inner highlighted text; null for a point comment. */
  highlightStart: number | null
  highlightEnd: number | null
  /** Inner comment text (between the comment delimiters). */
  commentStart: number
  commentEnd: number
  quote: string
  text: string
  syntax: CritiqueSyntax
  /** 0-indexed line of `start`. */
  line: number
}

// Order matters: anchored forms before their bare point-comment forms.
const COMMENT_RE = new RegExp([
  // The highlight can't contain `==`, or a bare highlight earlier on the line
  // would swallow everything up to the next commented one.
  String.raw`==([^\n=](?:(?:[^\n=]|=(?!=))*?[^\n=])??)==%%([^\n]*?)%%`,
  String.raw`\{==([^\n]*?)==\}\{>>([^\n]*?)<<\}`,
  String.raw`\{>>([^\n]*?)<<\}`,
  String.raw`%%([^\n%](?:[^\n]*?[^\n%])??)%%`,
].join("|"), "g")

const FENCE_RE = /^\s*(`{3,}|~{3,})/

/** Offsets covered by fenced code blocks and inline code spans; comments
 *  inside them are literal text, but code spans inside a comment are fine. */
function codeRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let offset = 0
  let fence: { marker: string; start: number } | null = null
  for (const line of text.split("\n")) {
    const end = offset + line.length
    const m = FENCE_RE.exec(line)
    if (fence) {
      if (m && m[1]![0] === fence.marker[0] && m[1]!.length >= fence.marker.length && !line.trim().slice(m[1]!.length)) {
        out.push([fence.start, end])
        fence = null
      }
    } else if (m) {
      fence = { marker: m[1]!, start: offset }
    } else {
      for (const code of line.matchAll(/`[^`\n]+`/g)) {
        out.push([offset + code.index!, offset + code.index! + code[0].length])
      }
    }
    offset = end + 1
  }
  if (fence) out.push([fence.start, text.length])
  return out
}

export function parseCritiqueComments(text: string): CritiqueComment[] {
  const code = codeRanges(text)
  const out: CritiqueComment[] = []
  let line = 0
  let lineScan = 0
  for (const m of text.matchAll(COMMENT_RE)) {
    const start = m.index!
    const end = start + m[0].length
    let comment: Omit<CritiqueComment, "start" | "end" | "line">
    if (m[1] != null) {
      const hs = start + 2
      const he = hs + m[1].length
      comment = anchored(hs, he, he + 4, m[1], m[2]!, "obsidian")
    } else if (m[3] != null) {
      const hs = start + 3
      const he = hs + m[3].length
      comment = anchored(hs, he, he + 6, m[3], m[4]!, "critic")
    } else if (m[5] != null) {
      comment = point(start + 3, m[5], "critic")
    } else {
      comment = point(start + 2, m[6]!, "obsidian")
    }
    const inside = (a: number, b: number) =>
      (a >= comment.commentStart && b <= comment.commentEnd)
      || (comment.highlightStart != null && a >= comment.highlightStart && b <= comment.highlightEnd!)
    if (code.some(([a, b]) => start < b && end > a && !inside(a, b))) continue
    for (; lineScan < start; lineScan++) if (text.charCodeAt(lineScan) === 10) line++
    out.push({ start, end, line, ...comment })
  }
  return out
}

function anchored(hs: number, he: number, cs: number, quote: string, text: string, syntax: CritiqueSyntax) {
  return {
    highlightStart: hs,
    highlightEnd: he,
    commentStart: cs,
    commentEnd: cs + text.length,
    quote,
    text: text.trim(),
    syntax,
  }
}

function point(cs: number, text: string, syntax: CritiqueSyntax) {
  return {
    highlightStart: null,
    highlightEnd: null,
    commentStart: cs,
    commentEnd: cs + text.length,
    quote: "",
    text: text.trim(),
    syntax,
  }
}

/** Collapse newlines and strip the delimiters that would end the comment early. */
export function sanitizeCommentText(text: string, syntax: CritiqueSyntax): string {
  const flat = text.replace(/\s*\n\s*/g, " ").trim()
  return syntax === "obsidian" ? flat.replace(/%%/g, "%") : flat.replace(/<<\}/g, "<< }")
}

/** Render a comment in `syntax`. `quote` null/empty makes a point comment;
 *  a blank comment on a quote is just the highlight. */
export function formatCritiqueComment(quote: string | null, comment: string, syntax: CritiqueSyntax): string {
  const body = sanitizeCommentText(comment, syntax)
  if (syntax === "critic") return quote ? (body ? `{==${quote}==}{>>${body}<<}` : `{==${quote}==}`) : `{>>${body}<<}`
  return quote ? (body ? `==${quote}==%%${body}%%` : `==${quote}==`) : `%%${body}%%`
}

/** Delimiter ranges to hide when rendering inline (everything except the
 *  highlighted text). Absolute offsets, sorted. */
export function critiqueHiddenRanges(c: CritiqueComment): Array<[number, number]> {
  if (c.highlightStart == null || c.highlightEnd == null) return [[c.start, c.end]]
  return [[c.start, c.highlightStart], [c.highlightEnd, c.end]]
}

/** Comment whose construct contains `pos` (inclusive of the end edge). */
export function critiqueCommentAt(comments: readonly CritiqueComment[], pos: number): CritiqueComment | null {
  return comments.find(c => pos >= c.start && pos <= c.end) ?? null
}
