import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { cppFontLock, cppIndentLine, installCppMode } from "../../src/modes/cpp"
import { getMode, modeFeature, type TextSpan } from "../../src/modes/mode"

function expectSpan(text: string, spans: TextSpan[], needle: string, face: TextSpan["face"]): void {
  const start = text.indexOf(needle)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

test("c++-mode installs C++ mode definitions", () => {
  installCppMode()

  expect(getMode("c++-mode")?.parent).toBe("c")
  expect(getMode("c++-mode")?.commentStart).toBe("//")
  expect(getMode("c++-ts-mode")?.parent).toBe("c++-mode")
  expect(modeFeature("c++-mode", "fontLock")).toBe(cppFontLock)
  expect(modeFeature("c++-mode", "indentLine")).toBe(cppIndentLine)
  expect(modeFeature("c++-ts-mode", "fontLock")).toBe(cppFontLock)
})

test("c++-mode font-lock highlights C and C++ syntax", () => {
  installCppMode()
  const text = [
    "// shape interface",
    "namespace demo {",
    "template <typename T>",
    "class Box final {",
    "public:",
    "    constexpr Box(T value) noexcept : value(value) {}",
    "    auto get() const -> T { return this->value; }",
    "private:",
    "    T value = nullptr;",
    "};",
    "bool ok = true;",
    "auto casted = static_cast<int>(42);",
    "const char* s = \"class namespace\";",
    "}",
  ].join("\n")
  const buffer = new BufferModel({ name: "box.cpp", text, mode: "c++-mode" })
  const spans = cppFontLock(buffer)

  expectSpan(text, spans, "// shape interface", "comment")
  expectSpan(text, spans, "namespace", "keyword")
  expectSpan(text, spans, "template", "keyword")
  expectSpan(text, spans, "typename", "keyword")
  expectSpan(text, spans, "class", "keyword")
  expectSpan(text, spans, "Box", "type")
  expectSpan(text, spans, "final", "keyword")
  expectSpan(text, spans, "public", "keyword")
  expectSpan(text, spans, "constexpr", "keyword")
  expectSpan(text, spans, "noexcept", "keyword")
  expectSpan(text, spans, "auto", "keyword")
  expectSpan(text, spans, "return", "keyword")
  expectSpan(text, spans, "this", "keyword")
  expectSpan(text, spans, "private", "keyword")
  expectSpan(text, spans, "nullptr", "keyword")
  expectSpan(text, spans, "bool", "keyword")
  expectSpan(text, spans, "true", "keyword")
  expectSpan(text, spans, "static_cast", "keyword")
  expectSpan(text, spans, "42", "number")
  expectSpan(text, spans, "\"class namespace\"", "string")

  const ranged = cppFontLock(buffer, { startLine: 10, endLine: 12, start: buffer.lineStarts[10]!, end: buffer.lineStarts[12]! })
  expect(ranged.some(span => text.slice(span.start, span.end) === "namespace")).toBe(false)
  expectSpan(text, ranged, "bool", "keyword")
  expectSpan(text, ranged, "static_cast", "keyword")
})

test("c++-mode indents braces with width four", () => {
  installCppMode()
  const buffer = new BufferModel({ name: "main.cpp", text: "int main() {\nreturn 0;\n    }\n", mode: "c++-mode" })
  const indentLine = modeFeature("c++-mode", "indentLine")!

  buffer.point = buffer.text.indexOf("return")
  indentLine(buffer)
  expect(buffer.text).toContain("int main() {\n    return 0;\n")

  buffer.point = buffer.text.indexOf("}")
  indentLine(buffer)
  expect(buffer.text).toContain("    return 0;\n}\n")
})
