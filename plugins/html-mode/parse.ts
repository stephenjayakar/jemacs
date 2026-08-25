/**
 * A small, dependency-free HTML parser.
 *
 * Only what `html-mode` needs to lay out a document: elements, attributes, text and
 * entities. It is deliberately lenient -- unclosed tags and stray `<` are recovered from
 * rather than rejected, because the input is a buffer someone is midway through typing.
 */

export type HtmlNode =
  | { kind: "text"; text: string }
  | { kind: "element"; tag: string; attrs: Record<string, string>; children: HtmlNode[] }

/** Elements that never have children and need no closing tag. */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
])

/** Elements whose content is raw text, not markup. */
const RAW_TEXT_TAGS = new Set(["script", "style"])

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      return isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** Parse `source` into a node list. Never throws. */
export function parseHtml(source: string): HtmlNode[] {
  const root: HtmlNode[] = []
  // Stack of open elements; children are appended to the innermost.
  const stack: Array<Extract<HtmlNode, { kind: "element" }>> = []
  const push = (node: HtmlNode) => {
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(node)
    else root.push(node)
  }
  const pushText = (raw: string) => {
    if (!raw) return
    const text = decodeEntities(raw)
    if (text.trim()) push({ kind: "text", text })
  }

  let pos = 0
  while (pos < source.length) {
    const lt = source.indexOf("<", pos)
    if (lt === -1) {
      pushText(source.slice(pos))
      break
    }
    pushText(source.slice(pos, lt))

    // Comments and doctype are dropped: neither contributes to layout.
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4)
      pos = end === -1 ? source.length : end + 3
      continue
    }
    if (source.startsWith("<!", lt)) {
      const end = source.indexOf(">", lt)
      pos = end === -1 ? source.length : end + 1
      continue
    }

    const gt = source.indexOf(">", lt)
    if (gt === -1) {
      // A stray '<' with no '>': treat the remainder as text.
      pushText(source.slice(lt))
      break
    }

    const inner = source.slice(lt + 1, gt).trim()
    pos = gt + 1

    if (inner.startsWith("/")) {
      const tag = inner.slice(1).trim().toLowerCase()
      // Close the nearest matching element; ignore unmatched closers.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.tag === tag) {
          stack.length = i
          break
        }
      }
      continue
    }

    const match = /^([a-z0-9-]+)/i.exec(inner)
    if (!match) continue
    const tag = match[1]!.toLowerCase()
    const selfClosing = inner.endsWith("/")
    const element = {
      kind: "element" as const,
      tag,
      attrs: parseAttributes(inner.slice(match[0].length)),
      children: [] as HtmlNode[],
    }
    push(element)

    if (selfClosing || VOID_TAGS.has(tag)) continue

    if (RAW_TEXT_TAGS.has(tag)) {
      // Skip to the matching close tag without parsing the contents as markup.
      const close = source.toLowerCase().indexOf(`</${tag}`, pos)
      const end = close === -1 ? source.length : close
      const raw = source.slice(pos, end).trim()
      if (raw) element.children.push({ kind: "text", text: raw })
      const closeGt = close === -1 ? -1 : source.indexOf(">", close)
      pos = closeGt === -1 ? source.length : closeGt + 1
      continue
    }

    stack.push(element)
  }

  return root
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern = /([a-z0-9-:@.]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    const name = match[1]!.toLowerCase()
    if (name === "/") continue
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "")
  }
  return attrs
}

/** Concatenated text of a node and its descendants, whitespace-collapsed. */
export function textContent(node: HtmlNode): string {
  if (node.kind === "text") return node.text
  return node.children.map(textContent).join("").replace(/\s+/g, " ").trim()
}
