import type { BufferModel } from "../kernel/buffer"
import { defineMode, type CompletionCandidate, type Mode, type TextSpan } from "./mode"
import { createTreeSitterFontLock } from "./tree-sitter"

const javascriptKeywords = new Set("async await break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield".split(" "))
const htmlKeywords = new Set("html head body title meta link script style div span p a img ul ol li table tr td th form input button label select option textarea h1 h2 h3 h4 h5 h6".split(" "))
const javaKeywords = new Set("abstract assert break case catch class continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while true false null var record sealed permits".split(" "))
const rustKeywords = new Set("as async await break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while".split(" "))
const goKeywords = new Set("break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var".split(" "))
const protoKeywords = new Set("syntax package import option message enum service rpc returns repeated optional reserved oneof map string int32 int64 uint32 uint64 bool bytes double float".split(" "))

export function installConfigModes(): void {
  defineTreeSitterCodeMode("javascript", javascriptKeywords, "//", 2)
  defineTreeSitterCodeMode("typescript", javascriptKeywords, "//", 2)
  defineTreeSitterCodeMode("html", htmlKeywords, "<!--", 2, "text")
  defineTreeSitterCodeMode("java", javaKeywords, "//", 4)
  defineCodeMode("rust", rustKeywords, "//", 4)
  defineCodeMode("go", goKeywords, "//", 4)
  const protobuf = defineCodeMode("protobuf", protoKeywords, "//", 2)
  protobuf.keymap?.bind("C-c n", "proto-renumber")
  defineCodeMode("terraform", new Set("resource data variable output provider module locals terraform true false null".split(" ")), "#", 2)
  defineCodeMode("prisma", new Set("generator datasource model enum type view relation fields references default id unique map db updatedAt".split(" ")), "//", 2)
  defineCodeMode("glsl", new Set("attribute const uniform varying layout centroid flat smooth noperspective break continue do for while switch case default if else in out inout float int void bool true false lowp mediump highp precision invariant discard return mat2 mat3 mat4 vec2 vec3 vec4".split(" ")), "//", 2)
  defineCodeMode("elixir", new Set("def defmodule defp do end case cond else fn if nil true false use import alias require receive try rescue catch after".split(" ")), "#", 2)
  defineCodeMode("jenkinsfile", new Set("pipeline agent stages stage steps post environment options when script sh echo parallel".split(" ")), "//", 2)
  defineCodeMode("yaml", new Set("true false null yes no on off".split(" ")), "#", 2, "text")
  defineMode({ name: "handlebars", parent: "text", commentStart: "{{!", fontLock: handlebarsFontLock })
  defineMode({ name: "restclient", parent: "text", commentStart: "#", fontLock: restClientFontLock })
}

function defineCodeMode(name: string, keywords: Set<string>, commentStart: string, indentWidth: number, parent = "prog-mode"): Mode {
  return defineMode({
    name,
    parent,
    commentStart,
    indentLine: buffer => braceIndentLine(buffer, indentWidth),
    fontLock: buffer => codeFontLock(buffer, keywords, commentStart),
    completeAtPoint: buffer => wordCompleteAtPoint(buffer, keywords),
  })
}

function defineTreeSitterCodeMode(name: string, keywords: Set<string>, commentStart: string, indentWidth: number, parent = "prog-mode"): Mode {
  return defineMode({
    name,
    parent,
    commentStart,
    indentLine: buffer => braceIndentLine(buffer, indentWidth),
    fontLock: createTreeSitterFontLock(name),
    completeAtPoint: buffer => wordCompleteAtPoint(buffer, keywords),
  })
}

export function braceIndentLine(buffer: BufferModel, width: number): void {
  const line = buffer.lineBoundsAt()
  const before = buffer.text.slice(0, line.start)
  const opens = (before.match(/[({[]/g) ?? []).length
  const closes = (before.match(/[)}\]]/g) ?? []).length
  const current = line.text.trimStart()
  const desired = Math.max(0, (opens - closes - (/^[)}\]]/.test(current) ? 1 : 0)) * width)
  const oldIndent = line.text.length - current.length
  const column = buffer.point - line.start
  buffer.replaceRange(line.start, line.end, " ".repeat(desired) + current)
  buffer.point = line.start + Math.max(desired, column + desired - oldIndent)
}

export function codeFontLock(buffer: BufferModel, keywords: Set<string>, commentStart: string): TextSpan[] {
  const spans: TextSpan[] = []
  const text = buffer.text
  for (let i = 0; i < text.length;) {
    if (text.startsWith(commentStart, i)) {
      const end = lineEnd(text, i)
      spans.push({ start: i, end, face: "comment" })
      i = end
      continue
    }
    const ch = text[i]!
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch
      let end = i + 1
      while (end < text.length) {
        if (text[end] === "\\") end += 2
        else if (text[end] === quote) { end++; break }
        else end++
      }
      spans.push({ start: i, end, face: "string" })
      i = end
      continue
    }
    i++
  }
  addWords(text, /\b\d+(?:\.\d+)?\b/g, "number", spans)
  addWords(text, /\b[A-Za-z_]\w*\b/g, "keyword", spans, word => keywords.has(word))
  addWords(text, /\b(?:function|func|fn|def)\s+([A-Za-z_]\w*)/g, "function", spans, undefined, 1)
  addWords(text, /\b(?:class|struct|interface|trait|enum|message|service|model)\s+([A-Za-z_]\w*)/g, "type", spans, undefined, 1)
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

function handlebarsFontLock(buffer: BufferModel): TextSpan[] {
  const spans: TextSpan[] = []
  for (const match of buffer.text.matchAll(/{{[#/>!]?\s*[^}]+}}/g)) spans.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, face: match[0].startsWith("{{!") ? "comment" : "keyword" })
  return spans
}

function restClientFontLock(buffer: BufferModel): TextSpan[] {
  const spans: TextSpan[] = []
  addWords(buffer.text, /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm, "keyword", spans)
  addWords(buffer.text, /^\s*#.*$/gm, "comment", spans)
  return spans
}

function wordCompleteAtPoint(buffer: BufferModel, keywords: Set<string>): CompletionCandidate[] {
  const symbol = buffer.symbolBoundsAt()
  if (!symbol.text) return []
  const words = new Set(keywords)
  for (const match of buffer.text.matchAll(/\b[A-Za-z_]\w*\b/g)) words.add(match[0])
  return [...words].filter(word => word.startsWith(symbol.text) && word !== symbol.text).sort().map(text => ({ text, start: symbol.start, end: symbol.end }))
}

function addWords(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], pred?: (word: string) => boolean, group = 0): void {
  for (const match of text.matchAll(regex)) {
    const word = match[group] ?? match[0]
    if (pred && !pred(word)) continue
    const base = match.index ?? 0
    const start = group ? base + match[0].lastIndexOf(word) : base
    if (!insideStringOrComment(spans, start)) spans.push({ start, end: start + word.length, face })
  }
}

function insideStringOrComment(spans: TextSpan[], point: number): boolean {
  return spans.some(span => point >= span.start && point < span.end && (span.face === "string" || span.face === "comment"))
}

function lineEnd(text: string, start: number): number {
  const end = text.indexOf("\n", start)
  return end === -1 ? text.length : end
}
