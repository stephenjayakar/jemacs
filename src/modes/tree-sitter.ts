import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { BufferModel } from "../kernel/buffer"
import type { FaceName, FontLockRange, TextSpan } from "./mode"

const require = createRequire(import.meta.url)

type SyntaxNode = import("tree-sitter").SyntaxNode
type Language = import("tree-sitter").Language
type Parser = import("tree-sitter")

const CAPTURE_FACES: Record<string, FaceName> = {
  keyword: "keyword",
  "keyword.import": "keyword",
  "keyword.directive": "keyword",
  string: "string",
  comment: "comment",
  number: "number",
  float: "number",
  boolean: "constant",
  "function": "function",
  "function.builtin": "builtin",
  "function.method": "function",
  "method": "function",
  "type": "type",
  "type.builtin": "type",
  "constant": "constant",
  "constant.builtin": "constant",
  builtin: "builtin",
  property: "default",
  variable: "default",
  parameter: "default",
  namespace: "type",
  module: "type",
  label: "default",
  operator: "keyword",
  punctuation: "default",
  tag: "keyword",
  attribute: "type",
  "text.title": "type",
  "text.literal": "string",
  "text.uri": "string",
  "text.reference": "function",
  "text.emphasis": "constant",
  "text.strong": "builtin",
  "markup.heading": "type",
  "markup.raw": "string",
  "markup.link": "function",
  "markup.quote": "comment",
  "markup.list": "keyword",
}

const CAPTURE_PRIORITY: Record<string, number> = {
  comment: 10,
  string: 20,
  number: 30,
  constant: 40,
  "constant.builtin": 41,
  builtin: 42,
  "function.builtin": 43,
  keyword: 50,
  operator: 51,
  type: 60,
  "constructor": 61,
  function: 70,
  "function.method": 71,
  method: 72,
  property: 5,
  variable: 1,
  default: 0,
}

export type TreeSitterLanguageSpec = {
  language: Language
  highlightsPath?: string
  extraHighlights?: string
  highlight?: (root: SyntaxNode, text?: string) => TextSpan[]
}

const languageSpecs: Map<string, TreeSitterLanguageSpec> = new Map()

export function registerTreeSitterLanguage(name: string, spec: TreeSitterLanguageSpec): void {
  languageSpecs.set(name, spec)
  parsers.delete(name)
  for (const key of [...queries.keys()]) {
    if (key.startsWith(spec.highlightsPath ?? `\0${name}`)) queries.delete(key)
  }
}

export function registeredTreeSitterLanguages(): string[] {
  return [...languageSpecs.keys()]
}

const parsers = new Map<string, Parser>()
const queries = new Map<string, import("tree-sitter").Query>()
/** Per-buffer cached tree + the exact text it was parsed from, so the next
 *  call can `tree.edit()` + reparse incrementally instead of from scratch. */
const trees = new WeakMap<BufferModel, { tree: import("tree-sitter").Tree; text: string; language: string }>()

export function treeSitterFontLock(language: string, buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spec = languageSpecs.get(language)
  if (!spec) return []
  try {
    const ParserCtor = resolveParserCtor()
    const parser = parserFor(language, spec.language, ParserCtor)
    const tree = parseIncremental(parser, language, buffer)
    if (spec.highlightsPath) return highlightWithQuery(spec, tree.rootNode, ParserCtor, range)
    const spans = spec.highlight?.(tree.rootNode, buffer.text) ?? []
    return range ? spans.filter(span => span.end >= range.start && span.start <= range.end) : spans
  } catch (error) {
    if (process.env.JEMACS_DEBUG_FONT_LOCK === "1") {
      console.error(`tree-sitter font-lock failed for ${language}:`, error)
    }
    trees.delete(buffer)
    return []
  }
}

export function createTreeSitterFontLock(language: string): (buffer: BufferModel, range?: FontLockRange) => TextSpan[] {
  return (buffer, range) => treeSitterFontLock(language, buffer, range)
}

function parseIncremental(parser: Parser, language: string, buffer: BufferModel): import("tree-sitter").Tree {
  const text = buffer.text
  const cached = trees.get(buffer)
  if (cached?.language === language) {
    if (cached.text === text) return cached.tree
    cached.tree.edit(diffEdit(cached.text, text, buffer))
    const tree = parser.parse(text, cached.tree)
    trees.set(buffer, { tree, text, language })
    return tree
  }
  const tree = parser.parse(text)
  trees.set(buffer, { tree, text, language })
  return tree
}

/** Derive the single bounding edit between two texts via common prefix/suffix.
 *  `onTextChange` is single-assignment (LSP owns it), so we recover the edit
 *  here instead — O(n) char compares, far cheaper than a full parse. */
function diffEdit(oldText: string, newText: string, buffer: BufferModel): import("tree-sitter").Edit {
  const minLen = Math.min(oldText.length, newText.length)
  let pre = 0
  while (pre < minLen && oldText.charCodeAt(pre) === newText.charCodeAt(pre)) pre++
  let suf = 0
  const sufMax = minLen - pre
  while (suf < sufMax && oldText.charCodeAt(oldText.length - 1 - suf) === newText.charCodeAt(newText.length - 1 - suf)) suf++
  const startIndex = pre
  const oldEndIndex = oldText.length - suf
  const newEndIndex = newText.length - suf
  const startPosition = pointInBuffer(buffer, startIndex)
  return {
    startIndex, oldEndIndex, newEndIndex,
    startPosition,
    newEndPosition: pointInBuffer(buffer, newEndIndex),
    oldEndPosition: advancePoint(startPosition, oldText, startIndex, oldEndIndex),
  }
}

function pointInBuffer(buffer: BufferModel, index: number): import("tree-sitter").Point {
  const row = buffer.lineAt(index)
  return { row, column: index - buffer.lineStarts[row]! }
}

function advancePoint(from: import("tree-sitter").Point, text: string, lo: number, hi: number): import("tree-sitter").Point {
  let row = from.row, col = from.column
  for (let i = lo; i < hi; i++) {
    if (text.charCodeAt(i) === 10) { row++; col = 0 } else col++
  }
  return { row, column: col }
}

/** tree-sitter ships as a CJS module whose `module.exports` IS the Parser
 *  constructor (with a static `.Query`). Under different interop it may also
 *  surface as `.default`. Resolve both shapes. */
function resolveParserCtor(): ParserCtorType {
  const mod = require("tree-sitter")
  return (mod.default ?? mod) as ParserCtorType
}

type ParserCtorType = (new () => Parser) & { Query: new (lang: Language, source: string) => import("tree-sitter").Query }

function parserFor(language: string, grammar: Language, ParserCtor: ParserCtorType): Parser {
  let parser = parsers.get(language)
  if (!parser) {
    parser = new ParserCtor()
    parser.setLanguage(grammar)
    parsers.set(language, parser)
  }
  return parser
}

function queryFor(spec: TreeSitterLanguageSpec, ParserCtor: ParserCtorType): import("tree-sitter").Query | undefined {
  if (!spec.highlightsPath) return undefined
  const extra = spec.extraHighlights ?? ""
  const key = spec.highlightsPath + extra
  let query = queries.get(key)
  if (!query) {
    const source = readFileSync(spec.highlightsPath, "utf8") + extra
    query = new ParserCtor.Query(spec.language, source)
    queries.set(key, query)
  }
  return query
}

function highlightWithQuery(spec: TreeSitterLanguageSpec, root: SyntaxNode, ParserCtor: ParserCtorType, range?: FontLockRange): TextSpan[] {
  const query = queryFor(spec, ParserCtor)
  if (!query) return []
  const candidates: Array<{ start: number, end: number, face: FaceName, priority: number }> = []
  const options = range ? {
    startIndex: range.start,
    endIndex: range.end,
  } : undefined

  for (const capture of query.captures(root, options)) {
    const face = captureFace(capture.name)
    if (!face || face === "default") continue
    candidates.push({
      start: capture.node.startIndex,
      end: capture.node.endIndex,
      face,
      priority: CAPTURE_PRIORITY[capture.name] ?? CAPTURE_PRIORITY[face] ?? 1,
    })
  }

  candidates.sort((a, b) =>
    b.priority - a.priority
    || a.start - b.start
    || (a.end - a.start) - (b.end - b.start)
    || a.end - b.end,
  )
  let chosen: typeof candidates = []
  for (let i = 0; i < candidates.length;) {
    const pri = candidates[i]!.priority
    let j = i
    while (j < candidates.length && candidates[j]!.priority === pri) j++
    chosen = mergeTier(chosen, candidates, i, j)
    i = j
  }
  return chosen.map(({ start, end, face }) => ({ start, end, face }))
}

function mergeTier<T extends { start: number; end: number }>(chosen: T[], tier: readonly T[], lo: number, hi: number): T[] {
  const out: T[] = []
  let ci = 0, ti = lo, lastEnd = -1
  while (ci < chosen.length || ti < hi) {
    if (ci < chosen.length && (ti >= hi || chosen[ci]!.start <= tier[ti]!.start)) {
      const c = chosen[ci++]!
      out.push(c)
      if (c.end > lastEnd) lastEnd = c.end
    } else {
      const t = tier[ti++]!
      const hitsNext = ci < chosen.length && chosen[ci]!.start < t.end
      if (t.start >= lastEnd && !hitsNext) { out.push(t); lastEnd = t.end }
    }
  }
  return out
}

function captureFace(name: string): FaceName | undefined {
  if (name === "constructor") return "type"
  const base = name.split(".")[0]!
  return CAPTURE_FACES[name] ?? CAPTURE_FACES[base]
}

export function queryPath(packageName: string): string | undefined {
  try {
    const pkgJson = require.resolve(`${packageName}/package.json`)
    const path = join(dirname(pkgJson), "queries", "highlights.scm")
    return path
  } catch {
    return undefined
  }
}
