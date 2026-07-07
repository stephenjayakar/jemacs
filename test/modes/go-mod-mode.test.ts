import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { goModFontLock, goModIndentLine, goSumFontLock, installGoModModes } from "../../src/modes/go-mod"
import { getMode, modeFeature, type TextSpan } from "../../src/modes/mode"

function expectSpan(text: string, spans: TextSpan[], needle: string, face: TextSpan["face"], from = 0): void {
  const start = text.indexOf(needle, from)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

test("go-mod-mode and go-sum-mode install GNU mode names", () => {
  installGoModModes()

  expect(getMode("go-mod-mode")?.parent).toBe("prog-mode")
  expect(getMode("go-mod-mode")?.commentStart).toBe("//")
  expect(modeFeature("go-mod-mode", "fontLock")).toBe(goModFontLock)
  expect(modeFeature("go-mod-mode", "indentLine")).toBe(goModIndentLine)
  expect(getMode("go-sum-mode")?.parent).toBe("text")
  expect(modeFeature("go-sum-mode", "fontLock")).toBe(goSumFontLock)
})

test("go-mod-mode font-lock highlights directives, strings, versions, and comments", () => {
  installGoModModes()
  const text = [
    "module example.com/jemacs",
    "go 1.22",
    "toolchain go1.22.4",
    "",
    "require (",
    "\tgithub.com/BurntSushi/toml v1.4.0",
    ")",
    "replace github.com/old/mod v1.2.3 => \"../local\"",
    "exclude example.com/bad v0.1.0 // broken",
    "retract [v1.0.0, v1.1.0]",
    "use ./tools",
  ].join("\n")
  const buffer = new BufferModel({ name: "go.mod", text, mode: "go-mod-mode" })
  const spans = goModFontLock(buffer)

  expectSpan(text, spans, "module", "keyword")
  expectSpan(text, spans, "go", "keyword", text.indexOf("go 1.22"))
  expectSpan(text, spans, "toolchain", "keyword")
  expectSpan(text, spans, "require", "keyword")
  expectSpan(text, spans, "v1.4.0", "constant")
  expectSpan(text, spans, "replace", "keyword")
  expectSpan(text, spans, "v1.2.3", "constant")
  expectSpan(text, spans, "\"../local\"", "string")
  expectSpan(text, spans, "exclude", "keyword")
  expectSpan(text, spans, "v0.1.0", "constant")
  expectSpan(text, spans, "// broken", "comment")
  expectSpan(text, spans, "retract", "keyword")
  expectSpan(text, spans, "v1.0.0", "constant")
  expectSpan(text, spans, "v1.1.0", "constant")
  expectSpan(text, spans, "use", "keyword")

  const ranged = goModFontLock(buffer, { startLine: 4, endLine: 8, start: buffer.lineStarts[4]!, end: buffer.lineStarts[8]! })
  expect(ranged.some(span => text.slice(span.start, span.end) === "module")).toBe(false)
  expectSpan(text, ranged, "require", "keyword")
  expectSpan(text, ranged, "v1.4.0", "constant")
  expectSpan(text, ranged, "replace", "keyword")
})

test("go-sum-mode font-lock highlights module path, version, and hash lines", () => {
  installGoModModes()
  const text = [
    "github.com/BurntSushi/toml v1.4.0 h1:abcdef",
    "github.com/BurntSushi/toml v1.4.0/go.mod h1:123456",
  ].join("\n")
  const buffer = new BufferModel({ name: "go.sum", text, mode: "go-sum-mode" })
  const spans = goSumFontLock(buffer)

  expectSpan(text, spans, "github.com/BurntSushi/toml", "function")
  expectSpan(text, spans, "v1.4.0", "constant")
  expectSpan(text, spans, "h1:abcdef", "string")
  expectSpan(text, spans, "github.com/BurntSushi/toml", "function", text.indexOf("\n") + 1)
  expectSpan(text, spans, "v1.4.0/go.mod", "constant")
  expectSpan(text, spans, "h1:123456", "string")
})

test("go-mod-mode indentation uses tabs inside parenthesized blocks", () => {
  installGoModModes()
  const buffer = new BufferModel({
    name: "go.mod",
    text: [
      "require (",
      "    github.com/BurntSushi/toml v1.4.0",
      "\t)",
      "  replace example.com/old => ./old",
    ].join("\n"),
    mode: "go-mod-mode",
  })

  buffer.point = buffer.text.indexOf("github.com")
  goModIndentLine(buffer)
  expect(buffer.text).toContain("require (\n\tgithub.com/BurntSushi/toml v1.4.0\n")

  buffer.point = buffer.text.indexOf(")")
  goModIndentLine(buffer)
  expect(buffer.text).toContain("v1.4.0\n)\n")

  buffer.point = buffer.text.indexOf("replace")
  goModIndentLine(buffer)
  expect(buffer.text).toContain(")\nreplace example.com/old => ./old")
})
