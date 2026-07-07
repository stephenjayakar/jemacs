import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { getMode, modeFeature, type TextSpan } from "../../src/modes/mode"
import { installTomlMode } from "../../src/modes/toml"

function faceAt(text: string, spans: TextSpan[], needle: string): TextSpan["face"] | undefined {
  const start = text.indexOf(needle)
  expect(start).toBeGreaterThanOrEqual(0)
  return spans.find(span => span.start === start)?.face
}

test("toml-mode installs a prog-mode child with TOML comments", () => {
  installTomlMode()

  expect(getMode("toml-mode")?.parent).toBe("prog-mode")
  expect(getMode("toml-mode")?.commentStart).toBe("#")
  expect(modeFeature("toml-mode", "fontLock")).toBeDefined()
  expect(modeFeature("toml-mode", "indentLine")).toBeDefined()
})

test("toml-mode font-lock highlights TOML comments, values, headers, and keys", () => {
  installTomlMode()
  const text = [
    "# config",
    "title = \"Jemacs\"",
    "literal = 'raw value'",
    "multiline = \"\"\"hello",
    "world\"\"\"",
    "enabled = true",
    "ratio = -1.5e+2",
    "date = 2026-07-06T12:34:56Z",
    "[server]",
    "port = 8080",
    "[[products]]",
    "name = 'Hammer'",
  ].join("\n")
  const buffer = new BufferModel({ name: "config.toml", text, mode: "toml-mode" })
  const spans = modeFeature("toml-mode", "fontLock")!(buffer)

  expect(faceAt(text, spans, "# config")).toBe("comment")
  expect(faceAt(text, spans, "title")).toBe("keyword")
  expect(faceAt(text, spans, "\"Jemacs\"")).toBe("string")
  expect(faceAt(text, spans, "'raw value'")).toBe("string")
  expect(faceAt(text, spans, "\"\"\"hello\nworld\"\"\"")).toBe("string")
  expect(faceAt(text, spans, "true")).toBe("keyword")
  expect(faceAt(text, spans, "-1.5e+2")).toBe("number")
  expect(faceAt(text, spans, "2026-07-06T12:34:56Z")).toBe("constant")
  expect(faceAt(text, spans, "[server]")).toBe("type")
  expect(faceAt(text, spans, "port")).toBe("keyword")
  expect(faceAt(text, spans, "[[products]]")).toBe("type")
})

test("toml-mode indentation keeps lines at column zero", () => {
  installTomlMode()
  const buffer = new BufferModel({ name: "config.toml", text: "  title = \"x\"\n[server]\n    port = 8080\n", mode: "toml-mode" })
  const indentLine = modeFeature("toml-mode", "indentLine")!

  buffer.point = buffer.text.indexOf("title")
  indentLine(buffer)
  expect(buffer.text.startsWith("title = \"x\"")).toBe(true)

  buffer.point = buffer.text.indexOf("port")
  indentLine(buffer)
  expect(buffer.text).toContain("[server]\nport = 8080\n")
})
