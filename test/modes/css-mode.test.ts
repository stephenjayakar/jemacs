import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { installCssMode } from "../../src/modes/css"
import { getMode, modeFeature, type TextSpan } from "../../src/modes/mode"

function faceAt(text: string, spans: TextSpan[], needle: string): TextSpan["face"] | undefined {
  const start = text.indexOf(needle)
  expect(start).toBeGreaterThanOrEqual(0)
  return spans.find(span => span.start === start)?.face
}

test("css-mode installs css, scss, and sass mode definitions", () => {
  installCssMode()

  expect(getMode("css-mode")?.parent).toBe("prog-mode")
  expect(getMode("css-mode")?.commentStart).toBe("/*")
  expect(getMode("scss-mode")?.parent).toBe("css-mode")
  expect(getMode("sass-mode")?.parent).toBe("css-mode")
  expect(modeFeature("css-mode", "fontLock")).toBeDefined()
  expect(modeFeature("css-mode", "indentLine")).toBeDefined()
  expect(modeFeature("css-mode", "imenuIndex")).toBeDefined()
})

test("css-mode font-lock highlights common CSS syntax", () => {
  installCssMode()
  const text = [
    "/* card styles */",
    "@media screen and (min-width: 40rem) {",
    ".card:hover {",
    "color: #ff00aa;",
    "margin: 1.5rem 0 !important;",
    "content: \"hello\";",
    "}",
    "}",
  ].join("\n")
  const buffer = new BufferModel({ name: "style.css", text, mode: "css-mode" })
  const spans = modeFeature("css-mode", "fontLock")!(buffer)

  expect(faceAt(text, spans, "/* card styles */")).toBe("comment")
  expect(faceAt(text, spans, "@media")).toBe("keyword")
  expect(faceAt(text, spans, ".card:hover")).toBe("function")
  expect(faceAt(text, spans, "color")).toBe("type")
  expect(faceAt(text, spans, "#ff00aa")).toBe("constant")
  expect(faceAt(text, spans, "00aa")).toBeUndefined()
  expect(faceAt(text, spans, "1.5rem")).toBe("number")
  expect(faceAt(text, spans, "!important")).toBe("keyword")
  expect(faceAt(text, spans, "\"hello\"")).toBe("string")
})

test("css-mode indents nested declarations with generic brace indentation", () => {
  installCssMode()
  const buffer = new BufferModel({ name: "style.css", text: ".card {\ncolor: red;\n  }\n", mode: "css-mode" })
  const indentLine = modeFeature("css-mode", "indentLine")!

  buffer.point = buffer.text.indexOf("color")
  indentLine(buffer)
  expect(buffer.text).toContain(".card {\n  color: red;")

  buffer.point = buffer.text.indexOf("}")
  indentLine(buffer)
  expect(buffer.text).toContain("  color: red;\n}\n")
})
