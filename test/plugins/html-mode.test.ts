import { describe, expect, test } from "bun:test"
import { parseHtml, decodeEntities, textContent } from "../../plugins/html-mode/parse"
import { renderHtml } from "../../plugins/html-mode/render"
import { HTML_DEMOS } from "../../plugins/html-mode/demos"
import type { WebNodeModel } from "../../src/kernel/extension-points"

/** Depth-first list of every node in the tree, for structural assertions. */
function flatten(nodes: WebNodeModel[]): WebNodeModel[] {
  return nodes.flatMap(node => [node, ...flatten(node.children ?? [])])
}

function texts(nodes: WebNodeModel[]): string[] {
  return flatten(nodes).map(node => node.text ?? "").filter(Boolean)
}

describe("decodeEntities", () => {
  test("decodes named entities", () => {
    expect(decodeEntities("a &amp; b &lt; c &gt; d")).toBe("a & b < c > d")
    expect(decodeEntities("&copy; &mdash;")).toBe("© —")
  })

  test("decodes numeric and hex entities", () => {
    expect(decodeEntities("&#65;&#66;")).toBe("AB")
    expect(decodeEntities("&#x41;")).toBe("A")
  })

  test("leaves unknown entities alone", () => {
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;")
  })
})

describe("parseHtml", () => {
  test("parses nested elements and attributes", () => {
    const nodes = parseHtml('<div class="a"><p>hi</p></div>')
    expect(nodes).toHaveLength(1)
    const div = nodes[0]!
    expect(div).toMatchObject({ kind: "element", tag: "div", attrs: { class: "a" } })
    expect(div.kind === "element" && div.children[0]).toMatchObject({ tag: "p" })
  })

  test("handles void elements without a closing tag", () => {
    const nodes = parseHtml("<p>a<br>b</p><hr>")
    expect(nodes).toHaveLength(2)
    expect(nodes[1]).toMatchObject({ tag: "hr" })
  })

  test("drops comments and doctype", () => {
    const nodes = parseHtml("<!doctype html><!-- note --><p>x</p>")
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ tag: "p" })
  })

  test("does not parse markup inside script or style", () => {
    const nodes = parseHtml("<script>if (a < b) { x() }</script>")
    expect(nodes).toHaveLength(1)
    const script = nodes[0]!
    expect(script.kind === "element" && script.children[0]).toMatchObject({
      kind: "text",
      text: "if (a < b) { x() }",
    })
  })

  test("recovers from unclosed tags", () => {
    const nodes = parseHtml("<div><p>unclosed")
    expect(textContent(nodes[0]!)).toBe("unclosed")
  })

  test("recovers from a stray less-than", () => {
    expect(() => parseHtml("a < b")).not.toThrow()
    expect(parseHtml("<p>a < b</p>").length).toBeGreaterThan(0)
  })

  test("ignores unmatched closing tags", () => {
    const nodes = parseHtml("</div><p>x</p>")
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ tag: "p" })
  })

  test("parses unquoted and single-quoted attributes", () => {
    const nodes = parseHtml("<a href=http://x.test title='hi'>y</a>")
    expect(nodes[0]).toMatchObject({ attrs: { href: "http://x.test", title: "hi" } })
  })
})

describe("renderHtml", () => {
  test("headings get level-specific faces", () => {
    const { nodes } = renderHtml("<h1>One</h1><h3>Three</h3>")
    expect(nodes[0]).toMatchObject({ text: "One", face: "markdownHeader1" })
    expect(nodes[1]).toMatchObject({ text: "Three", face: "markdownHeader3" })
  })

  test("script and style contribute nothing", () => {
    const { nodes } = renderHtml("<style>p{color:red}</style><script>x()</script><p>only</p>")
    expect(texts(nodes)).toEqual(["only"])
  })

  test("an inline-only paragraph stays on one row", () => {
    const { nodes } = renderHtml("<p>Hello <b>bold</b> world</p>")
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.kind).toBe("row")
    expect(texts(nodes)).toEqual(["Hello", "bold", "world"])
  })

  test("links keep their href as a tooltip", () => {
    const { nodes } = renderHtml('<p><a href="https://x.test/a">label</a></p>')
    const link = flatten(nodes).find(node => node.face === "link")
    expect(link).toMatchObject({ text: "label", title: "https://x.test/a" })
  })

  test("lists are numbered or bulleted and indented", () => {
    const { nodes } = renderHtml("<ol><li>first</li><li>second</li></ol>")
    expect(texts(nodes)).toEqual(["1.", "first", "2.", "second"])
  })

  test("nested lists increase indent", () => {
    const { nodes } = renderHtml("<ul><li>outer<ul><li>inner</li></ul></li></ul>")
    const indents = nodes.map(node => node.indent ?? 0)
    expect(Math.max(...indents)).toBeGreaterThan(Math.min(...indents))
  })

  test("progress becomes a clamped bar", () => {
    const { nodes } = renderHtml('<progress value="30" max="60"></progress>')
    expect(nodes[0]).toMatchObject({ kind: "bar", value: 0.5 })
  })

  test("out-of-range progress is clamped, not propagated", () => {
    const { nodes } = renderHtml('<progress value="900" max="100"></progress>')
    expect(nodes[0]).toMatchObject({ kind: "bar", value: 1 })
  })

  test("buttons and images become badges", () => {
    const { nodes } = renderHtml('<button>Go</button><img alt="Chart">')
    expect(nodes[0]).toMatchObject({ kind: "badge", text: "Go" })
    expect(nodes[1]!.kind).toBe("badge")
    expect(nodes[1]!.text).toContain("Chart")
  })

  test("pre preserves line breaks", () => {
    const { nodes } = renderHtml("<pre>a\nb</pre>")
    expect(texts(nodes)).toEqual(["a", "b"])
  })

  test("tables align columns and add a header rule", () => {
    const { nodes } = renderHtml(
      "<table><tr><th>Name</th><th>N</th></tr><tr><td>alpha</td><td>1</td></tr></table>",
    )
    const rows = nodes.filter(node => node.kind === "row")
    expect(rows).toHaveLength(2)
    // Both rows pad to the same width, so columns line up.
    const first = rows[0]!.children!.map(cell => cell.text!.length)
    const second = rows[1]!.children!.map(cell => cell.text!.length)
    expect(first).toEqual(second)
    expect(nodes.some(node => (node.text ?? "").includes("─"))).toBe(true)
  })

  test("never emits a node kind outside the sandboxed vocabulary", () => {
    const allowed: string[] = ["row", "column", "text", "bar", "badge"]
    for (const demo of HTML_DEMOS) {
      const kinds = flatten(renderHtml(demo.source).nodes).map(node => String(node.kind))
      const offending = kinds.filter(kind => !allowed.includes(kind))
      expect({ demo: demo.name, offending }).toEqual({ demo: demo.name, offending: [] })
    }
  })

  test("produces a plain-text projection for the terminal", () => {
    const { text } = renderHtml("<h1>Title</h1><ul><li>item</li></ul>")
    expect(text).toContain("Title")
    expect(text).toContain("item")
  })

  test("malformed input still renders", () => {
    const { nodes } = renderHtml("<p>Unclosed <b>bold\n<p>a < b</p>")
    expect(texts(nodes).join(" ")).toContain("Unclosed")
  })

  test("empty input yields nothing rather than throwing", () => {
    expect(renderHtml("").nodes).toEqual([])
    expect(renderHtml("   ").text).toBe("")
  })
})

describe("built-in HTML demos", () => {
  test("each demo renders some content", () => {
    for (const demo of HTML_DEMOS) {
      const { nodes, text } = renderHtml(demo.source)
      expect({ demo: demo.name, empty: nodes.length === 0 })
        .toEqual({ demo: demo.name, empty: false })
      expect(text.length).toBeGreaterThan(0)
    }
  })

  test("the dashboard demo produces bars and badges", () => {
    const demo = HTML_DEMOS.find(d => d.name === "dashboard")!
    const kinds = new Set(flatten(renderHtml(demo.source).nodes).map(node => node.kind))
    expect(kinds.has("bar")).toBe(true)
    expect(kinds.has("badge")).toBe(true)
  })
})
