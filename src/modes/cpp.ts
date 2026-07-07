import type { BufferModel } from "../kernel/buffer"
import { braceIndentLine, codeFontLock } from "./generic"
import { defineMode, type CompletionCandidate, type FontLockRange, type TextSpan } from "./mode"

const cppKeywords = new Set([
  "auto", "break", "case", "catch", "char", "class", "concept", "const", "const_cast", "consteval", "constexpr", "constinit", "continue", "co_await", "co_return", "co_yield", "decltype", "default", "delete", "do", "double", "dynamic_cast", "else", "enum", "explicit", "export", "extern", "false", "final", "float", "for", "friend", "goto", "if", "inline", "int", "long", "mutable", "namespace", "new", "noexcept", "nullptr", "operator", "override", "private", "protected", "public", "register", "reinterpret_cast", "requires", "return", "short", "signed", "sizeof", "static", "static_cast", "struct", "switch", "template", "this", "throw", "true", "try", "typedef", "typename", "union", "unsigned", "using", "virtual", "void", "volatile", "while", "_Bool", "_Complex", "_Imaginary", "bool",
])

export function installCppMode(): void {
  defineMode({
    name: "c++-mode",
    parent: "c",
    commentStart: "//",
    indentLine: cppIndentLine,
    fontLock: cppFontLock,
    completeAtPoint: cppCompleteAtPoint,
  })
  defineMode({ name: "c++-ts-mode", parent: "c++-mode" })
}

export function cppIndentLine(buffer: BufferModel): void {
  braceIndentLine(buffer, 4)
}

export function cppFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  return codeFontLock(buffer, cppKeywords, "//", range)
}

export function cppCompleteAtPoint(buffer: BufferModel): CompletionCandidate[] {
  const symbol = buffer.symbolBoundsAt()
  if (!symbol.text) return []
  const words = new Set(cppKeywords)
  for (const match of buffer.text.matchAll(/\b[A-Za-z_]\w*\b/g)) words.add(match[0])
  return [...words]
    .filter(word => word.startsWith(symbol.text) && word !== symbol.text)
    .sort()
    .map(text => ({ text, start: symbol.start, end: symbol.end }))
}
