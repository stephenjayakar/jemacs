import type { WebNodeModel } from "../../src/kernel/extension-points"
import { parseHtml, textContent, type HtmlNode } from "./parse"

/**
 * Compile parsed HTML into the kernel's `WebNodeModel` vocabulary.
 *
 * The vocabulary is deliberately small -- containers, text, bars and badges -- and modes
 * cannot emit raw DOM. So this is a *translation*, not a browser: each element is mapped
 * to the closest structural equivalent, and anything unrecognised degrades to its text.
 * That boundary is what keeps a hostile or buggy document from reaching the renderer.
 *
 * Faces come from the active theme, so a rendered document follows the user's colours
 * instead of the page's.
 */

/** Elements that contribute nothing to a text layout. */
const DROPPED_TAGS = new Set(["script", "style", "head", "meta", "link", "title", "base"])

/** Heading tag -> face and a prefix that keeps the level legible in the TUI body text. */
const HEADING_FACES: Record<string, string> = {
  h1: "markdownHeader1",
  h2: "markdownHeader2",
  h3: "markdownHeader3",
  h4: "markdownHeader4",
  h5: "markdownHeader5",
  h6: "markdownHeader6",
}

const INLINE_TAGS = new Set([
  "a", "b", "strong", "i", "em", "u", "code", "span", "small",
  "kbd", "samp", "var", "abbr", "cite", "q", "sub", "sup", "s", "del", "ins", "mark",
])

/** Inline tag -> theme face, for the emphasis that survives translation. */
const INLINE_FACES: Record<string, string> = {
  a: "link",
  b: "bold",
  strong: "bold",
  i: "italic",
  em: "italic",
  code: "string",
  kbd: "string",
  samp: "string",
  var: "variableName",
  mark: "highlight",
  del: "comment",
  s: "comment",
}

export type HtmlRender = {
  nodes: WebNodeModel[]
  /** Plain-text rendering, used as the pane body so the TUI shows the same document. */
  text: string
}

export function renderHtml(source: string): HtmlRender {
  const parsed = parseHtml(source)
  const nodes: WebNodeModel[] = []
  for (const node of parsed) emitBlock(node, nodes, 0)
  return { nodes, text: nodes.length ? toPlainText(nodes) : "" }
}

/** True when the element should be laid out as its own block. */
function isBlock(node: HtmlNode): boolean {
  return node.kind === "element" && !INLINE_TAGS.has(node.tag)
}

/**
 * Emit `node` as one or more block-level rows into `out`.
 *
 * `indent` tracks nesting depth for lists and blockquotes; `WebNodeModel.indent` renders
 * it as a left margin in the GUI and as leading spaces in the text fallback.
 */
function emitBlock(node: HtmlNode, out: WebNodeModel[], indent: number): void {
  if (node.kind === "text") {
    const text = node.text.replace(/\s+/g, " ").trim()
    if (text) out.push({ kind: "text", text, indent })
    return
  }

  const { tag, attrs, children } = node
  if (DROPPED_TAGS.has(tag)) return

  if (HEADING_FACES[tag]) {
    const text = textContent(node)
    if (text) out.push({ kind: "text", text, face: HEADING_FACES[tag], indent })
    return
  }

  switch (tag) {
    case "br":
      out.push({ kind: "text", text: "", indent })
      return

    case "hr":
      out.push({ kind: "text", text: "─".repeat(40), face: "comment", indent })
      return

    case "img": {
      // No image decoding in the surface vocabulary; show the alt text, which is the
      // information the author intended a non-rendering client to see.
      const label = attrs.alt || attrs.src || "image"
      out.push({ kind: "badge", text: `▣ ${label}`, face: "comment", indent })
      return
    }

    case "ul":
    case "ol": {
      let counter = 0
      for (const child of children) {
        if (child.kind !== "element" || child.tag !== "li") continue
        counter++
        const marker = tag === "ol" ? `${counter}.` : "•"
        emitListItem(child, out, indent, marker)
      }
      return
    }

    case "li":
      emitListItem(node, out, indent, "•")
      return

    case "blockquote": {
      for (const child of children) emitBlock(child, out, indent + 1)
      return
    }

    case "pre": {
      // Preformatted text is the one place where the original line breaks matter.
      for (const line of textContentPreserving(node).split("\n")) {
        out.push({ kind: "text", text: line, face: "string", indent: indent + 1 })
      }
      return
    }

    case "table": {
      emitTable(node, out, indent)
      return
    }

    case "progress":
    case "meter": {
      const value = Number(attrs.value)
      const max = Number(attrs.max) || 1
      out.push({
        kind: "bar",
        value: isFinite(value) ? Math.max(0, Math.min(1, value / max)) : 0,
        text: attrs.title || (isFinite(value) ? `${value} / ${max}` : ""),
        face: "keyword",
        indent,
      })
      return
    }

    case "button":
    case "summary": {
      const text = textContent(node)
      if (text) out.push({ kind: "badge", text, face: "keyword", indent })
      return
    }

    case "input": {
      const label = attrs.placeholder || attrs.value || attrs.name || attrs.type || "input"
      out.push({ kind: "badge", text: `▢ ${label}`, face: "comment", indent })
      return
    }
  }

  // A container whose children are all inline collapses to a single row; that keeps a
  // paragraph of mixed <b>/<a>/text on one line instead of exploding it.
  const inlineOnly = children.length > 0 && children.every(child => !isBlock(child))
  if (inlineOnly) {
    const row = emitInlineRow(children, indent)
    if (row) out.push(row)
    return
  }

  for (const child of children) emitBlock(child, out, indent)
}

function emitListItem(node: HtmlNode, out: WebNodeModel[], indent: number, marker: string): void {
  if (node.kind !== "element") return
  const inline = node.children.filter(child => !isBlock(child))
  const blocks = node.children.filter(isBlock)

  const children: WebNodeModel[] = [{ kind: "text", text: marker, face: "comment" }]
  const row = emitInlineRow(inline, 0)
  if (row) children.push(...(row.children ?? [row]))
  out.push({ kind: "row", indent, children })

  for (const block of blocks) emitBlock(block, out, indent + 1)
}

/** Build one flex row from a run of inline nodes, or null when there is no text. */
function emitInlineRow(nodes: HtmlNode[], indent: number): WebNodeModel | null {
  const children: WebNodeModel[] = []
  collectInline(nodes, children, undefined)
  if (!children.length) return null
  if (children.length === 1 && children[0]!.kind === "text") {
    return { ...children[0]!, indent }
  }
  return { kind: "row", indent, children }
}

function collectInline(nodes: HtmlNode[], out: WebNodeModel[], face: string | undefined): void {
  for (const node of nodes) {
    if (node.kind === "text") {
      const text = node.text.replace(/\s+/g, " ")
      if (text.trim()) out.push({ kind: "text", text: text.trim(), face })
      continue
    }
    if (DROPPED_TAGS.has(node.tag)) continue
    if (node.tag === "br") continue
    if (node.tag === "img") {
      out.push({ kind: "badge", text: `▣ ${node.attrs.alt || node.attrs.src || "image"}`, face: "comment" })
      continue
    }

    const childFace = INLINE_FACES[node.tag] ?? face
    if (node.tag === "a" && node.attrs.href) {
      const label = textContent(node) || node.attrs.href
      // The href is preserved as a tooltip rather than a click target: the surface has no
      // navigation model, and silently swallowing the URL would lose information.
      out.push({ kind: "text", text: label, face: "link", title: node.attrs.href })
      continue
    }
    collectInline(node.children, out, childFace)
  }
}

/** Render a table as aligned rows; the surface vocabulary has no table primitive. */
function emitTable(node: HtmlNode, out: WebNodeModel[], indent: number): void {
  if (node.kind !== "element") return
  const rows: Array<{ cells: string[]; header: boolean }> = []
  const walk = (n: HtmlNode) => {
    if (n.kind !== "element") return
    if (n.tag === "tr") {
      const cells: string[] = []
      let header = false
      for (const cell of n.children) {
        if (cell.kind !== "element") continue
        if (cell.tag === "th") header = true
        if (cell.tag === "th" || cell.tag === "td") cells.push(textContent(cell))
      }
      if (cells.length) rows.push({ cells, header })
      return
    }
    for (const child of n.children) walk(child)
  }
  walk(node)
  if (!rows.length) return

  const columns = Math.max(...rows.map(row => row.cells.length))
  const widths: number[] = []
  for (let c = 0; c < columns; c++) {
    widths[c] = Math.max(...rows.map(row => (row.cells[c] ?? "").length), 3)
  }

  for (const row of rows) {
    const children: WebNodeModel[] = []
    for (let c = 0; c < columns; c++) {
      children.push({
        kind: "text",
        text: (row.cells[c] ?? "").padEnd(widths[c]!),
        face: row.header ? "bold" : undefined,
      })
    }
    out.push({ kind: "row", indent, children })
    if (row.header) {
      out.push({
        kind: "text",
        text: widths.map(w => "─".repeat(w)).join("  "),
        face: "comment",
        indent,
      })
    }
  }
}

/** Text of a node with newlines intact, for <pre>. */
function textContentPreserving(node: HtmlNode): string {
  if (node.kind === "text") return node.text
  return node.children.map(textContentPreserving).join("")
}

/** Flatten surface nodes back to plain text for the TUI body. */
export function toPlainText(nodes: WebNodeModel[]): string {
  const lines: string[] = []
  const render = (node: WebNodeModel): string => {
    if (node.kind === "row") return (node.children ?? []).map(render).join(" ")
    if (node.kind === "column") return (node.children ?? []).map(render).join(" ")
    if (node.kind === "bar") {
      const filled = Math.round((node.value ?? 0) * 20)
      return `[${"█".repeat(filled)}${"░".repeat(20 - filled)}] ${node.text ?? ""}`.trim()
    }
    if (node.kind === "badge") return `[${node.text ?? ""}]`
    return node.text ?? ""
  }
  for (const node of nodes) {
    lines.push("  ".repeat(node.indent ?? 0) + render(node))
  }
  return lines.join("\n")
}
