/** Inline markdown for short single-line text (margin notes, labels): strips
 *  the markers and reports which faces cover which parts of what remains.
 *  Covers code spans, `**strong**`/`__strong__`, `*em*`/`_em_`, `~~strike~~`,
 *  `[links](url)`, `[[wiki|links]]`, and backslash escapes. */
export type InlineMarkdownSpan = { start: number; end: number; face: string }
export type InlineMarkdown = { text: string; spans: InlineMarkdownSpan[] }

const DELIMITERS = [
  { marker: "**", face: "markdown-strong" },
  { marker: "__", face: "markdown-strong" },
  { marker: "~~", face: "markdown-strikethrough" },
  { marker: "*", face: "markdown-emphasis" },
  { marker: "_", face: "markdown-emphasis" },
] as const

const ESCAPABLE = /[!-/:-@[-`{-~]/
const WORD = /[\p{L}\p{N}]/u

export function parseInlineMarkdown(src: string): InlineMarkdown {
  const spans: InlineMarkdownSpan[] = []
  let out = ""
  const wrap = (inner: string, face: string) => {
    const start = out.length
    walk(inner)
    if (out.length > start) spans.push({ start, end: out.length, face })
  }
  const walk = (s: string): void => {
    let i = 0
    while (i < s.length) {
      const ch = s[i]!
      if (ch === "\\" && ESCAPABLE.test(s[i + 1] ?? "")) {
        out += s[i + 1]
        i += 2
        continue
      }
      if (ch === "`") {
        const run = backtickRun(s, i)
        const close = s.indexOf(run, i + run.length)
        if (close > i) {
          let code = s.slice(i + run.length, close)
          if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1)
          spans.push({ start: out.length, end: out.length + code.length, face: "markdown-inline-code" })
          out += code
          i = close + run.length
          continue
        }
        out += run
        i += run.length
        continue
      }
      if (ch === "[") {
        const rest = s.slice(i)
        const wiki = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(rest)
        if (wiki) {
          wrap(wiki[2] ?? wiki[1]!, "markdown-link")
          i += wiki[0].length
          continue
        }
        const link = /^\[([^\]]+)\]\([^)\s]*\)/.exec(rest)
        if (link) {
          wrap(link[1]!, "markdown-link")
          i += link[0].length
          continue
        }
      }
      const d = DELIMITERS.find(d => opensAt(s, i, d.marker))
      const close = d ? closeOf(s, i + d.marker.length, d.marker) : -1
      if (d && close > i + d.marker.length) {
        wrap(s.slice(i + d.marker.length, close), d.face)
        i = close + d.marker.length
        continue
      }
      out += ch
      i++
    }
  }
  walk(src)
  return { text: out, spans }
}

function backtickRun(s: string, i: number): string {
  let j = i
  while (s[j] === "`") j++
  return s.slice(i, j)
}

/** Left-flanking, and `_` may not open inside a word. */
function opensAt(s: string, i: number, marker: string): boolean {
  if (!s.startsWith(marker, i)) return false
  const after = s[i + marker.length]
  if (after == null || /\s/.test(after)) return false
  return marker[0] !== "_" || !WORD.test(s[i - 1] ?? "")
}

/** Index of the closing `marker`, skipping escapes, code spans, and (for a
 *  single-character marker) its doubled form, so `*a **b** c*` pairs up. */
function closeOf(s: string, from: number, marker: string): number {
  for (let j = from; j < s.length;) {
    if (s[j] === "\\") { j += 2; continue }
    if (s[j] === "`") {
      const run = backtickRun(s, j)
      const end = s.indexOf(run, j + run.length)
      j = end < 0 ? j + run.length : end + run.length
      continue
    }
    if (marker.length === 1 && s.startsWith(marker + marker, j)) { j += 2; continue }
    if (s.startsWith(marker, j) && !/\s/.test(s[j - 1] ?? " ")
      && (marker[0] !== "_" || !WORD.test(s[j + marker.length] ?? ""))) return j
    j++
  }
  return -1
}
