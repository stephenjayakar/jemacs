import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { getMode, modeFeature, type TextSpan } from "../../src/modes/mode"
import { installXmlMode, xmlFontLock, xmlImenuIndex, xmlIndentLine } from "../../src/modes/xml"

function expectSpan(text: string, spans: TextSpan[], needle: string, face: TextSpan["face"]): void {
  const start = text.indexOf(needle)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

function expectSpanAt(text: string, spans: TextSpan[], needle: string, face: TextSpan["face"], from = 0): void {
  const start = text.indexOf(needle, from)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

test("xml-mode registers GNU XML, nXML, and SGML mode names", () => {
  installXmlMode()

  expect(getMode("xml-mode")?.parent).toBe("text")
  expect(getMode("xml-mode")?.commentStart).toBe("<!--")
  expect(getMode("nxml-mode")?.parent).toBe("xml-mode")
  expect(getMode("sgml-mode")?.parent).toBe("xml-mode")
  expect(modeFeature("nxml-mode", "fontLock")).toBe(xmlFontLock)
  expect(modeFeature("sgml-mode", "indentLine")).toBe(xmlIndentLine)
})

test("xml-mode font-lock highlights XML markup", () => {
  installXmlMode()
  const text = [
    "<?xml version=\"1.0\"?>",
    "<!DOCTYPE note SYSTEM \"note.dtd\">",
    "<message id=\"n1\" type='reminder'>",
    "  <!-- greeting -->",
    "  <body>User &amp; Admin</body>",
    "  <![CDATA[<escaped>&not-entity;</escaped>]]>",
    "  <empty/>",
    "</message>",
  ].join("\n")
  const buffer = new BufferModel({ name: "message.xml", text, mode: "xml-mode" })
  const spans = xmlFontLock(buffer)

  expectSpan(text, spans, "<?xml version=\"1.0\"?>", "keyword")
  expectSpan(text, spans, "version", "type")
  expectSpan(text, spans, "\"1.0\"", "string")
  expectSpan(text, spans, "<!DOCTYPE note SYSTEM \"note.dtd\">", "keyword")
  expectSpan(text, spans, "message", "function")
  expectSpan(text, spans, "id", "type")
  expectSpan(text, spans, "\"n1\"", "string")
  expectSpan(text, spans, "type", "type")
  expectSpan(text, spans, "'reminder'", "string")
  expectSpan(text, spans, "<!-- greeting -->", "comment")
  expectSpan(text, spans, "body", "function")
  expectSpan(text, spans, "&amp;", "constant")
  expectSpan(text, spans, "<![CDATA[<escaped>&not-entity;</escaped>]]>", "string")
  expect(spans.some(span => text.slice(span.start, span.end) === "&not-entity;")).toBe(false)
  expectSpanAt(text, spans, "message", "function", text.indexOf("</message>"))

  const ranged = xmlFontLock(buffer, { startLine: 2, endLine: 5, start: buffer.lineStarts[2]!, end: buffer.lineStarts[5]! })
  expect(ranged.some(span => text.slice(span.start, span.end).startsWith("<?xml"))).toBe(false)
  expectSpan(text, ranged, "message", "function")
  expectSpan(text, ranged, "<!-- greeting -->", "comment")
  expectSpan(text, ranged, "&amp;", "constant")
})

test("xml-mode indentation follows open elements without counting self-closing or void tags", () => {
  installXmlMode()
  const buffer = new BufferModel({
    name: "layout.xml",
    text: "<root>\n<section>\n<br>\n<empty />\n<item>One</item>\n</section>\n</root>\n",
    mode: "xml-mode",
  })

  buffer.point = buffer.text.indexOf("<section>")
  xmlIndentLine(buffer)
  expect(buffer.text).toContain("<root>\n  <section>")

  buffer.point = buffer.text.indexOf("<br>")
  xmlIndentLine(buffer)
  expect(buffer.text).toContain("  <section>\n    <br>")

  buffer.point = buffer.text.indexOf("<empty")
  xmlIndentLine(buffer)
  expect(buffer.text).toContain("    <br>\n    <empty />")

  buffer.point = buffer.text.indexOf("<item>")
  xmlIndentLine(buffer)
  expect(buffer.text).toContain("    <empty />\n    <item>One</item>")

  buffer.point = buffer.text.indexOf("</section>")
  xmlIndentLine(buffer)
  expect(buffer.text).toContain("    <item>One</item>\n  </section>")

  buffer.point = buffer.text.indexOf("</root>")
  xmlIndentLine(buffer)
  expect(buffer.text.endsWith("  </section>\n</root>\n")).toBe(true)
})

test("xml-mode imenu indexes top-level elements", () => {
  const text = [
    "<?xml version=\"1.0\"?>",
    "<book id=\"one\">",
    "  <chapter>Intro</chapter>",
    "</book>",
    "<appendix/>",
  ].join("\n")
  const buffer = new BufferModel({ name: "book.xml", text, mode: "xml-mode" })

  expect(xmlImenuIndex(buffer)).toEqual([
    { name: "book", point: text.indexOf("book") },
    { name: "appendix", point: text.indexOf("appendix") },
  ])
})
