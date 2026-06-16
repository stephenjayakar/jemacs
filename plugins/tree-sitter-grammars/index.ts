import { createRequire } from "node:module"
import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import type { FaceName, FontLockRange, TextSpan } from "../../src/modes/mode"
import { defineMode, getMode } from "../../src/modes/mode"
import { createTreeSitterFontLock, queryPath, registerTreeSitterLanguage } from "../../src/modes/tree-sitter"
import { codeFontLock } from "../../src/modes/generic"

const require = createRequire(import.meta.url)

function interop<T>(mod: unknown): T {
  return ((mod as { default?: T }).default ?? mod) as T
}

type SyntaxNode = import("tree-sitter").SyntaxNode
type Language = import("tree-sitter").Language
type Parser = import("tree-sitter")
type ParserCtor = new () => Parser

const TS_EXTRA_HIGHLIGHTS = `
([(identifier) (statement_identifier)] @keyword
 (#match? @keyword "^(export|type|interface|enum|declare|namespace|abstract|readonly)$"))
`

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

const javascriptKeywords = new Set("async await break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield".split(" "))
const htmlKeywords = new Set("html head body title meta link script style div span p a img ul ol li table tr td th form input button label select option textarea h1 h2 h3 h4 h5 h6".split(" "))
const javaKeywords = new Set("abstract assert break case catch class continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while true false null var record sealed permits".split(" "))
const pythonKeywords = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "match", "case",
])

let markdownInlineLanguage: Language | null = null
const markdownInlineParsers = new Map<string, Parser>()

function pushSpan(spans: TextSpan[], node: SyntaxNode, face: FaceName): void {
  spans.push({ start: node.startIndex, end: node.endIndex, face })
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

function parserForInline(language: string, grammar: Language, ParserCtor: ParserCtor): Parser {
  let parser = markdownInlineParsers.get(language)
  if (!parser) {
    parser = new ParserCtor()
    parser.setLanguage(grammar)
    markdownInlineParsers.set(language, parser)
  }
  return parser
}

function highlightInlineRegion(
  spans: TextSpan[],
  node: SyntaxNode,
  text: string,
  inlineParser: Parser,
): void {
  const ranges = [{
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    startPosition: node.startPosition,
    endPosition: node.endPosition,
  }]
  const tree = inlineParser.parse(text, null, { includedRanges: ranges })
  const walkInline = (inlineNode: SyntaxNode): void => {
    switch (inlineNode.type) {
      case "strong_emphasis":
        pushSpan(spans, inlineNode, "markdown-strong" as FaceName)
        break
      case "emphasis":
        pushSpan(spans, inlineNode, "markdown-emphasis" as FaceName)
        break
      case "code_span":
        pushSpan(spans, inlineNode, "string")
        break
      case "shortcut_link":
      case "inline_link":
        pushSpan(spans, inlineNode, "function")
        break
      case "link_label":
      case "link_text":
      case "image_description":
        pushSpan(spans, inlineNode, "function")
        break
      case "link_destination":
      case "uri_autolink":
        pushSpan(spans, inlineNode, "string")
        break
      case "backslash_escape":
      case "hard_line_break":
        pushSpan(spans, inlineNode, "string")
        break
      case "code_span_delimiter":
      case "emphasis_delimiter":
        pushSpan(spans, inlineNode, "keyword")
        break
      default:
        break
    }
    for (const child of inlineNode.children) walkInline(child)
  }
  walkInline(tree.rootNode)
}

function highlightMarkdown(root: SyntaxNode, text: string, ParserCtor: ParserCtor): TextSpan[] {
  const spans: TextSpan[] = []
  if (!markdownInlineLanguage) return spans
  const inlineParser = parserForInline("markdown-inline", markdownInlineLanguage, ParserCtor)

  const walkBlock = (node: SyntaxNode): void => {
    switch (node.type) {
      case "atx_heading": {
        const marker = node.children.find(child => child.type.startsWith("atx_h"))
        if (marker) pushSpan(spans, marker, "keyword")
        const inline = node.children.find(child => child.type === "inline")
        if (inline) {
          pushSpan(spans, inline, "type")
          highlightInlineRegion(spans, inline, text, inlineParser)
        }
        return
      }
      case "setext_heading": {
        for (const child of node.children) {
          if (child.type === "paragraph") pushSpan(spans, child, "type")
          else if (child.type.startsWith("setext_h")) pushSpan(spans, child, "keyword")
        }
        return
      }
      case "fenced_code_block":
      case "indented_code_block":
        pushSpan(spans, node, "string")
        return
      case "block_quote":
        pushSpan(spans, node, "comment")
        return
      case "thematic_break":
      case "list_marker_plus":
      case "list_marker_minus":
      case "list_marker_star":
      case "list_marker_dot":
      case "list_marker_parenthesis":
      case "block_quote_marker":
        pushSpan(spans, node, "keyword")
        return
      case "html_block":
      case "html_comment":
        pushSpan(spans, node, "comment")
        return
      case "plus_metadata":
      case "minus_metadata":
        pushSpan(spans, node, "keyword")
        return
      case "info_string":
      case "language":
        pushSpan(spans, node, "type")
        return
      case "pipe_table_header":
      case "pipe_table_row":
      case "pipe_table_delimiter_row":
        for (const child of node.children) {
          if (child.type === "pipe_table_cell") pushSpan(spans, child, "type")
          else if (child.type === "pipe_table_delimiter_cell" || child.text === "|") pushSpan(spans, child, "keyword")
        }
        return
      case "inline":
        highlightInlineRegion(spans, node, text, inlineParser)
        return
      default:
        break
    }
    for (const child of node.children) walkBlock(child)
  }

  walkBlock(root)
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

function hybridFontLock(
  language: string,
  buffer: BufferModel,
  keywords: Set<string>,
  commentStart: string,
  range?: FontLockRange,
): TextSpan[] {
  const ts = createTreeSitterFontLock(language)(buffer, range)
  if (ts.length) return ts
  return codeFontLock(buffer, keywords, commentStart, range)
}

let registered = false

/** Synchronously load the tree-sitter grammar packages (CJS) and register them
 *  with the kernel. Idempotent. Used by `install` and directly by tests. */
export function registerTreeSitterGrammars(): void {
  if (registered) return
  // CJS interop: grammars and the Parser ctor surface as either the module
  // namespace itself or its `.default`, depending on the loader.
  const Python = interop<Language>(require("tree-sitter-python"))
  const JavaScript = interop<Language>(require("tree-sitter-javascript"))
  const HTML = interop<Language>(require("tree-sitter-html"))
  const Java = interop<Language>(require("tree-sitter-java"))
  const Markdown = interop<Language & { inline: Language }>(require("@tree-sitter-grammars/tree-sitter-markdown"))
  const ParserCtor = interop<ParserCtor>(require("tree-sitter"))

  markdownInlineLanguage = (Markdown as { inline: Language }).inline

  registerTreeSitterLanguage("python", {
    language: Python as Language,
    highlightsPath: queryPath("tree-sitter-python"),
  })
  registerTreeSitterLanguage("javascript", {
    language: JavaScript as Language,
    highlightsPath: queryPath("tree-sitter-javascript"),
  })
  registerTreeSitterLanguage("typescript", {
    language: JavaScript as Language,
    highlightsPath: queryPath("tree-sitter-javascript"),
    extraHighlights: TS_EXTRA_HIGHLIGHTS,
  })
  registerTreeSitterLanguage("html", {
    language: HTML as Language,
    highlight: highlightHtml,
  })
  registerTreeSitterLanguage("java", {
    language: Java as Language,
    highlight: highlightJava,
  })
  registerTreeSitterLanguage("markdown", {
    language: Markdown as Language,
    highlight: (root, text = "") => highlightMarkdown(root, text, ParserCtor),
  })
  registerTreeSitterLanguage("gfm", {
    language: Markdown as Language,
    highlight: (root, text = "") => highlightMarkdown(root, text, ParserCtor),
  })
  registered = true
}

function patchModeFontLock(
  name: string,
  language: string,
  keywords: Set<string>,
  commentStart: string,
): void {
  const mode = getMode(name)
  if (!mode) return
  defineMode({
    ...mode,
    fontLock: (buffer, range) => hybridFontLock(language, buffer, keywords, commentStart, range),
  })
}

export function install(_editor: Editor): void {
  registerTreeSitterGrammars()
  patchModeFontLock("javascript", "javascript", javascriptKeywords, "//")
  patchModeFontLock("typescript", "typescript", javascriptKeywords, "//")
  patchModeFontLock("html", "html", htmlKeywords, "<!--")
  patchModeFontLock("java", "java", javaKeywords, "//")
  patchModeFontLock("python", "python", pythonKeywords, "#")
  // markdown/gfm: plugins/markdown already uses treeSitterFontLock + header face overlay.
}
