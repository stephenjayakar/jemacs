import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import Parser from "tree-sitter"
import Python from "tree-sitter-python"
import JavaScript from "tree-sitter-javascript"
import HTML from "tree-sitter-html"
import Java from "tree-sitter-java"
import type { BufferModel } from "../kernel/buffer"
import type { FaceName, TextSpan } from "./mode"

const require = createRequire(import.meta.url)

type SyntaxNode = Parser.SyntaxNode
type Language = Parser.Language

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

const JAVA_KEYWORDS = new Set([
  "abstract", "assert", "break", "case", "catch", "class", "const", "continue", "default", "do", "else", "enum",
  "extends", "final", "finally", "for", "goto", "if", "implements", "import", "instanceof", "interface", "native",
  "new", "package", "private", "protected", "public", "return", "static", "strictfp", "super", "switch",
  "synchronized", "this", "throw", "throws", "transient", "try", "volatile", "while", "true", "false", "null",
  "var", "yield", "record", "sealed", "permits", "non-sealed",
])

const JAVA_TYPE_NODES = new Set([
  "integral_type", "boolean_type", "void_type", "floating_point_type", "type_identifier", "scoped_type_identifier",
  "generic_type",
])

const JAVA_NUMBER_NODES = new Set([
  "decimal_integer_literal", "hex_integer_literal", "octal_integer_literal", "binary_integer_literal",
  "decimal_floating_point_literal", "hex_floating_point_literal",
])

type LanguageSpec = {
  language: Language
  highlightsPath?: string
  highlight?: (root: SyntaxNode) => TextSpan[]
}

const languageSpecs: Map<string, LanguageSpec> = new Map([
  ["python", { language: Python as Language, highlightsPath: queryPath("tree-sitter-python") }],
  ["javascript", { language: JavaScript as Language, highlightsPath: queryPath("tree-sitter-javascript") }],
  ["typescript", { language: JavaScript as Language, highlightsPath: queryPath("tree-sitter-javascript") }],
  ["html", { language: HTML as Language, highlight: highlightHtml }],
  ["java", { language: Java as Language, highlight: highlightJava }],
])

const parsers = new Map<string, Parser>()
const queries = new Map<string, Parser.Query>()

export function treeSitterFontLock(language: string, buffer: BufferModel): TextSpan[] {
  const spec = languageSpecs.get(language)
  if (!spec) return []
  try {
    const parser = parserFor(language, spec.language)
    const tree = parser.parse(buffer.text)
    if (spec.highlightsPath) return highlightWithQuery(spec, tree.rootNode)
    return spec.highlight?.(tree.rootNode) ?? []
  } catch {
    return []
  }
}

export function createTreeSitterFontLock(language: string): (buffer: BufferModel) => TextSpan[] {
  return buffer => treeSitterFontLock(language, buffer)
}

function parserFor(language: string, grammar: Language): Parser {
  let parser = parsers.get(language)
  if (!parser) {
    parser = new Parser()
    parser.setLanguage(grammar)
    parsers.set(language, parser)
  }
  return parser
}

function queryFor(spec: LanguageSpec): Parser.Query | undefined {
  if (!spec.highlightsPath) return undefined
  let query = queries.get(spec.highlightsPath)
  if (!query) {
    const source = readFileSync(spec.highlightsPath, "utf8")
    query = new Parser.Query(spec.language, source)
    queries.set(spec.highlightsPath, query)
  }
  return query
}

function highlightWithQuery(spec: LanguageSpec, root: SyntaxNode): TextSpan[] {
  const query = queryFor(spec)
  if (!query) return []
  const candidates: Array<{ start: number, end: number, face: FaceName, priority: number }> = []

  for (const capture of query.captures(root)) {
    const face = captureFace(capture.name)
    if (!face || face === "default") continue
    candidates.push({
      start: capture.node.startIndex,
      end: capture.node.endIndex,
      face,
      priority: CAPTURE_PRIORITY[capture.name] ?? CAPTURE_PRIORITY[face] ?? 1,
    })
  }

  candidates.sort((a, b) => b.priority - a.priority || a.start - b.start || (a.end - a.start) - (b.end - b.start))
  const chosen: typeof candidates = []
  for (const candidate of candidates) {
    const covered = chosen.some(span =>
      span.priority > candidate.priority
      && span.start <= candidate.start
      && span.end >= candidate.end,
    )
    if (covered) continue
    const overlap = chosen.findIndex(span => candidate.start < span.end && candidate.end > span.start)
    if (overlap === -1) {
      chosen.push(candidate)
      continue
    }
    if (candidate.priority > chosen[overlap]!.priority) chosen[overlap] = candidate
  }

  return chosen
    .map(({ start, end, face }) => ({ start, end, face }))
    .sort((a, b) => a.start - b.start || a.end - b.end)
}

function highlightHtml(root: SyntaxNode): TextSpan[] {
  const spans: TextSpan[] = []
  const walk = (node: SyntaxNode): void => {
    switch (node.type) {
      case "comment":
        pushSpan(spans, node, "comment")
        break
      case "tag_name":
        pushSpan(spans, node, "keyword")
        break
      case "attribute_name":
        pushSpan(spans, node, "type")
        break
      case "quoted_attribute_value":
      case "attribute_value":
        pushSpan(spans, node, "string")
        break
      case "script_start_tag":
      case "style_start_tag":
        pushSpan(spans, node, "keyword")
        break
      default:
        break
    }
    for (const child of node.children) walk(child)
  }
  walk(root)
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

function highlightJava(root: SyntaxNode): TextSpan[] {
  const spans: TextSpan[] = []
  const walk = (node: SyntaxNode): void => {
    if (node.type === "comment" || node.type === "line_comment" || node.type === "block_comment") {
      pushSpan(spans, node, "comment")
    } else if (node.type === "string_literal" || node.type === "character_literal") {
      pushSpan(spans, node, "string")
    } else if (JAVA_NUMBER_NODES.has(node.type)) {
      pushSpan(spans, node, "number")
    } else if (node.type === "true" || node.type === "false" || node.type === "null_literal") {
      pushSpan(spans, node, "constant")
    } else if (JAVA_TYPE_NODES.has(node.type)) {
      pushSpan(spans, node, "keyword")
    } else if (!node.isNamed && JAVA_KEYWORDS.has(node.type)) {
      pushSpan(spans, node, "keyword")
    } else if (node.type === "class_declaration" || node.type === "interface_declaration" || node.type === "enum_declaration") {
      const name = node.childForFieldName("name")
      if (name) pushSpan(spans, name, "type")
    } else if (node.type === "method_declaration" || node.type === "constructor_declaration") {
      const name = node.childForFieldName("name")
      if (name) pushSpan(spans, name, "function")
    } else if (node.type === "type_identifier") {
      pushSpan(spans, node, "type")
    }
    for (const child of node.children) walk(child)
  }
  walk(root)
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

function pushSpan(spans: TextSpan[], node: SyntaxNode, face: FaceName): void {
  spans.push({ start: node.startIndex, end: node.endIndex, face })
}

function captureFace(name: string): FaceName | undefined {
  if (name === "constructor") return "type"
  return CAPTURE_FACES[name]
}

function queryPath(packageName: string): string | undefined {
  try {
    const pkgJson = require.resolve(`${packageName}/package.json`)
    const path = join(dirname(pkgJson), "queries", "highlights.scm")
    return path
  } catch {
    return undefined
  }
}
