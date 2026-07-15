import { join, parse } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { BufferModel, inferMode } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { addHook } from "../../src/kernel/hooks"
import { Keymap } from "../../src/kernel/keymap"
import { getTrackedAdvice } from "../../src/runtime/advice"
import { defcustom, getCustom, setCustom } from "../../src/runtime/custom"
import { defface, faceRemapAddRelative, FIXED_PITCH_FAMILY, VARIABLE_PITCH_FAMILY } from "../../src/runtime/faces"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defineMode, enterMode, getMode, modeFeature, type FaceName, type FontLockRange, type TextSpan } from "../../src/modes/mode"
import { registeredTreeSitterLanguages, treeSitterFontLock } from "../../src/modes/tree-sitter"
import { spawnProcess, writeFileText, type SpawnHandle, type SpawnOptions } from "../../src/platform/runtime"
import { registerTreeSitterGrammars } from "../tree-sitter-grammars"

const TAB_WIDTH = 4
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+/
const ORDERED_LIST_RE = /^(\s*)(\d+)([.)])\s+/
const ATX_HEADER_RE = /^(#{1,6})\s/
const BLOCKQUOTE_RE = /^(\s*)>+\s?/
const FENCED_CODE_RE = /^(`{3,}|~{3,})/
const FENCE_LINE_RE = /^(\s*)(`{3,}|~{3,})(\S*)(\s*)$/
const SETEXT_UNDERLINE_RE = /^(\s*)(=+|-+)\s*$/
const MARKDOWN_GFM_LANGUAGE_HISTORY = "markdown-gfm-language-history"

const DEFAULT_MARKDOWN_URI_TYPES = [
  "acap", "cid", "data", "dav", "fax", "file", "ftp", "geo", "gopher",
  "http", "https", "imap", "ldap", "mailto", "mid", "message", "modem",
  "news", "nfs", "nntp", "pop", "prospero", "rtsp", "service", "sip",
  "tel", "telnet", "tip", "urn", "vemmi", "wais",
]

const DEFAULT_GFM_CODE_LANGUAGES = [
  "bash", "c", "clojure", "cpp", "css", "diff", "dockerfile", "elisp",
  "emacs-lisp", "go", "html", "java", "javascript", "json", "jsx", "kotlin",
  "lua", "markdown", "python", "ruby", "rust", "scss", "sh", "shell", "sql",
  "swift", "tsx", "typescript", "xml", "yaml",
]

export const MARKDOWN_FOLDED_LOCAL = "markdown-folded"
export const MARKDOWN_SUBTREE_STATUS = "markdown-cycle-subtree-status"
export const MARKDOWN_GLOBAL_STATUS = "markdown-cycle-global-status"
const MARKDOWN_FILTER_CACHE = "markdown--display-filter-cache"
const MARKDOWN_LAST_INDENT = "markdown-last-indent-command"
const MARKDOWN_CYCLE_REPEAT = "markdown-cycle-repeat"
const MARKDOWN_FILL_COLUMN = "markdown-fill-column"
const MARKDOWN_VISUAL_FILL = "markdown-visual-fill-column-mode"
const MARKDOWN_FOOTNOTE_RETURN_POINT = "markdown-footnote-return-point"

defcustom("markdown-fill-column", "number", 100, "Soft-wrap width for markdown buffers (Stephen's Notion-style layout).")
defcustom("markdown-visual-fill-column-center-text", "boolean", true, "Center body text within the fill column.")
defcustom("markdown-fontify-code-blocks-natively", "boolean", false, "Fontify fenced code blocks using the language major mode.")
defcustom("markdown-fontify-code-block-default-mode", "string", "", "Default mode for fenced blocks with no language (empty = none).")
defcustom("markdown-code-lang-modes", "sexp", [
  ["cpp", "c"],
  ["C", "c"],
  ["C++", "c"],
  ["shell", "text"],
  ["bash", "text"],
  ["sh", "text"],
  ["elisp", "text"],
], "Alist mapping fence info strings to jemacs major modes.")
defcustom("markdown-uri-types", "sexp", DEFAULT_MARKDOWN_URI_TYPES, "Link types for syntax highlighting of URIs.")
defcustom(MARKDOWN_GFM_LANGUAGE_HISTORY, "sexp", [] as string[], "Languages used in GFM fenced code block prompts.")
defcustom("markdown-gfm-use-electric-backquote", "boolean", true, "When non-nil, typing ``` at BOL in GFM prompts for a fenced code language.")
defcustom("markdown-wiki-link-search-subdirectories", "boolean", false, "When non-nil, search for wiki link targets in subdirectories.")
defcustom("markdown-display-inline-images", "boolean", true, "Replace image links with inline placeholders in the display layer.")
defcustom("markdown-display-remote-images", "boolean", true, "Allow remote image URLs in inline image display.")
defcustom("markdown-hide-markup", "boolean", false, "Hide markup delimiters in the display layer (WYSIWYG-style editing).")
defcustom("markdown-hide-urls", "boolean", false, "Compose link URLs to a single glyph when markup hiding is active.")
defcustom("markdown-hide-markup-in-view-modes", "boolean", true, "Enable hidden markup in markdown-view-mode and gfm-view-mode.")
defcustom("markdown-command", "string", "markdown", "External Markdown processor used by `markdown-export`.")
defcustom("markdown-open-command", "string", process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open", "External command used by `markdown-open`.")
defcustom("markdown-indent-on-enter", "sexp", true, "RET behavior in markdown buffers: nil inserts a raw newline, t indents, and `indent-and-new-item` continues lists.")
defcustom("markdown-trim-trailing-whitespace-on-enter", "boolean", false, "Trim trailing whitespace from the previous line after RET.")
defcustom("word-wrap", "boolean", false, "Wrap display lines at word boundaries when soft wrapping.")

const MARKDOWN_HIDE_MARKUP = "markdown-hide-markup"
const MARKDOWN_HIDE_URLS = "markdown-hide-urls"
const MARKDOWN_FONTIFY_CODE_BLOCKS = "markdown-fontify-code-blocks-natively"
const LIST_BULLET = "•"
const URL_COMPOSE_CHAR = "↪"

const MARKDOWN_HEADER_FACES = [
  ["markdown-header-face-1", 2.0],
  ["markdown-header-face-2", 1.7],
  ["markdown-header-face-3", 1.4],
  ["markdown-header-face-4", 1.2],
  ["markdown-header-face-5", 1.1],
  ["markdown-header-face-6", 1.0],
] as const

export type MarkdownHeading = {
  line: number
  start: number
  end: number
  level: number
  title: string
}

export type FencedCodeBlock = {
  openLine: number
  closeLine: number
  bodyStart: number
  bodyEnd: number
  lang: string | null
  fence: string
}

export type FoldRange = [number, number]
const EMPTY_FOLD_RANGES: FoldRange[] = []
type SubtreeCycle = "folded" | "children" | "subtree"
type GlobalCycle = 1 | 2 | 3
type DisplayFilterResult = { text: string; map: (n: number) => number; unmap?: (n: number) => number }
type MarkupOp = { start: number; end: number; display: string }
type LineRenderMap = {
  text: string
  bufToDisp: number[]
  dispToBuf: number[]
}
type DisplayLineMap = {
  line: number
  dispStart: number
  displayLen: number
  bufToDisp?: number[]
  dispToBuf?: number[]
}
type DisplayFilterCache = {
  text: string
  ranges: FoldRange[]
  hideMarkup: boolean
  hideUrls: boolean
  result: DisplayFilterResult
}
export type MarkdownDeps = {
  spawn?: (opts: SpawnOptions) => SpawnHandle
  writeFile?: (path: string, text: string) => Promise<void>
  openExternal?: (target: string, opts?: { allowFile?: boolean }) => void
  now?: () => number
}

function markdownHideMarkup(buffer: BufferModel): boolean {
  const local = buffer.locals.get(MARKDOWN_HIDE_MARKUP)
  if (typeof local === "boolean") return local
  return getCustom<boolean>("markdown-hide-markup") ?? false
}

function markdownHideUrls(buffer: BufferModel): boolean {
  const local = buffer.locals.get(MARKDOWN_HIDE_URLS)
  if (typeof local === "boolean") return local
  return getCustom<boolean>("markdown-hide-urls") ?? false
}

function setMarkdownHideMarkup(buffer: BufferModel, value: boolean): void {
  buffer.locals.set(MARKDOWN_HIDE_MARKUP, value)
  buffer.locals.delete(MARKDOWN_FILTER_CACHE)
}

function setMarkdownHideUrls(buffer: BufferModel, value: boolean): void {
  buffer.locals.set(MARKDOWN_HIDE_URLS, value)
  buffer.locals.delete(MARKDOWN_FILTER_CACHE)
}

function markdownFontifyCodeBlocksNatively(buffer: BufferModel): boolean {
  const local = buffer.locals.get(MARKDOWN_FONTIFY_CODE_BLOCKS)
  if (typeof local === "boolean") return local
  return getCustom<boolean>("markdown-fontify-code-blocks-natively") ?? false
}

function setMarkdownFontifyCodeBlocksNatively(buffer: BufferModel, value: boolean): void {
  buffer.locals.set(MARKDOWN_FONTIFY_CODE_BLOCKS, value)
}

function markdownIsGfmMode(buffer: BufferModel): boolean {
  return buffer.mode === "gfm" || buffer.mode === "gfm-view-mode"
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function markdownExportHtml(title: string, body: string): string {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "  <meta charset=\"utf-8\">",
    `  <title>${escapeHtml(title)}</title>`,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n")
}

function markdownOutputPath(buffer: BufferModel): string | null {
  if (!buffer.path) return null
  const parsed = parse(buffer.path)
  return join(parsed.dir, `${parsed.name}.html`)
}

function markdownPreviewPath(buffer: BufferModel, deps: MarkdownDeps): string {
  const stamp = deps.now?.() ?? Date.now()
  const parsed = parse(buffer.name || "markdown")
  const stem = (parsed.name || "markdown").replace(/[^A-Za-z0-9._-]/g, "-")
  return join(tmpdir(), `jemacs-${stem}-${stamp}.html`)
}

function referenceLabelKey(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase()
}

export function markdownUndefinedReferenceLabels(text: string): string[] {
  const definitions = new Set<string>()
  for (const match of text.matchAll(/^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*/gm)) {
    const label = match[1]
    if (label && !label.startsWith("^")) definitions.add(referenceLabelKey(label))
  }

  const missing = new Map<string, string>()
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\[([^\]\n]+)\]/g)) {
    const label = match[1]
    if (!label || label.startsWith("^")) continue
    const key = referenceLabelKey(label)
    if (!definitions.has(key) && !missing.has(key)) missing.set(key, label)
  }
  return [...missing.values()]
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value?.length) out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

async function markdownRunProcessor(buffer: BufferModel, deps: MarkdownDeps): Promise<string> {
  const command = getCustom<string>("markdown-command") ?? "markdown"
  const spawn = deps.spawn ?? spawnProcess
  const proc = spawn({ cmd: ["sh", "-c", command], cwd: buffer.directory(), stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  proc.stdin?.write(buffer.text)
  proc.stdin?.end()
  const [stdout, stderr, code] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr), proc.exited])
  if (code !== 0) throw new Error(stderr.trim() || `markdown-command exited with code ${code ?? "?"}`)
  return stdout
}

export async function markdownExportBuffer(
  buffer: BufferModel,
  deps: MarkdownDeps = {},
  outputPath = markdownOutputPath(buffer),
): Promise<string> {
  if (!outputPath) throw new Error("Buffer is not visiting a file")
  const body = await markdownRunProcessor(buffer, deps)
  const html = markdownExportHtml(buffer.name, body)
  await (deps.writeFile ?? writeFileText)(outputPath, html)
  return outputPath
}

export function parseFencedCodeBlocks(text: string): FencedCodeBlock[] {
  const lines = text.split("\n")
  const blocks: FencedCodeBlock[] = []
  let offset = 0
  let open: { line: number; fence: string; lang: string | null; charEnd: number } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineStart = offset
    const lineEnd = lineStart + line.length
    const m = line.match(FENCE_LINE_RE)
    if (m?.[2]) {
      const fence = m[2]
      if (!open) {
        open = { line: i, fence, lang: m[3] || null, charEnd: lineEnd }
      } else if (fence === open.fence && !m[3]) {
        blocks.push({
          openLine: open.line,
          closeLine: i,
          bodyStart: open.charEnd + 1,
          bodyEnd: lineStart,
          lang: open.lang,
          fence: open.fence,
        })
        open = null
      }
    }
    offset = lineEnd + 1
  }
  return blocks
}

function markdownGetLangMode(lang: string | null): string | null {
  const fallbackRaw = getCustom<string>("markdown-fontify-code-block-default-mode") ?? ""
  const fallback = fallbackRaw && getMode(fallbackRaw) ? fallbackRaw : null
  if (!lang?.trim()) return fallback
  const normalized = lang.trim()
  const alist = getCustom<Array<[string, string]>>("markdown-code-lang-modes") ?? []
  for (const [key, mode] of alist) {
    if ((key === normalized || key.toLowerCase() === normalized.toLowerCase()) && getMode(mode)) return mode
  }
  const candidates = [
    inferMode(`block.${normalized}`),
    inferMode(`block.${normalized}.txt`),
    normalized,
    normalized.toLowerCase(),
  ]
  for (const mode of candidates) {
    if (mode !== "text" && modeFeature(mode, "fontLock")) return mode
  }
  if (registeredTreeSitterLanguages().includes(normalized)) return normalized
  const lower = normalized.toLowerCase()
  if (registeredTreeSitterLanguages().includes(lower)) return lower
  return fallback
}

export type EditIndirectState = {
  source: BufferModel
  bodyStart: number
  bodyEnd: number
  valid: boolean
  detach: () => void
}
const EDIT_INDIRECT_KEY = "markdown-edit-indirect"
const LIVE_PREVIEW_LOCAL = "markdown-live-preview"
const LIVE_PREVIEW_PATH_LOCAL = "markdown-live-preview-path"

/** Track the block body across source-buffer splices, edit-indirect style:
 *  edits before the body shift it, edits overlapping it invalidate the
 *  pending commit (the safe failure mode — Emacs edit-indirect errors too). */
export function attachEditIndirect(edit: BufferModel, source: BufferModel, bodyStart: number, bodyEnd: number): EditIndirectState {
  const prev = source.onTextChange
  const state: EditIndirectState = {
    source,
    bodyStart,
    bodyEnd,
    valid: true,
    detach: () => { source.onTextChange = prev },
  }
  source.onTextChange = ev => {
    const delta = ev.text.length - (ev.end - ev.start)
    if (ev.end <= state.bodyStart) {
      state.bodyStart += delta
      state.bodyEnd += delta
    } else if (ev.start < state.bodyEnd) {
      state.valid = false
    }
    prev?.(ev)
  }
  edit.locals.set(EDIT_INDIRECT_KEY, state)
  return state
}

export function finishEditIndirect(editor: Editor, edit: BufferModel, commit: boolean): void {
  const state = edit.locals.get(EDIT_INDIRECT_KEY) as EditIndirectState | undefined
  if (!state) {
    editor.message("Not editing a code block")
    return
  }
  if (commit) {
    if (!state.valid || !editor.buffers.has(state.source.id)) {
      editor.message("Source code block was modified or killed; cannot commit")
      return
    }
    state.detach()
    let body = edit.text
    if (body && !body.endsWith("\n")) body += "\n"
    state.source.replaceRange(state.bodyStart, state.bodyEnd, body)
  } else {
    state.detach()
  }
  edit.locals.delete(EDIT_INDIRECT_KEY)
  editor.killBuffer(edit.id)
  if (editor.buffers.has(state.source.id)) editor.switchToBuffer(state.source.id)
  editor.message(commit ? "Committed code block" : "Aborted code block edit")
}

export function editIndirectBuffer(edit: BufferModel): boolean {
  return edit.locals.has(EDIT_INDIRECT_KEY)
}

export function markdownCodeBlockAtPoint(text: string, point: number): FencedCodeBlock | null {
  for (const block of parseFencedCodeBlocks(text)) {
    const openStart = lineStartAt(text, block.openLine)
    const closeLineStart = lineStartAt(text, block.closeLine)
    const closeNl = text.indexOf("\n", closeLineStart)
    const closeEnd = closeNl < 0 ? text.length : closeNl
    if (point >= openStart && point <= closeEnd) return block
  }
  return null
}

function spanInsideRegions(start: number, end: number, regions: ReadonlyArray<readonly [number, number]>): boolean {
  return regions.some(([a, b]) => start >= a && end <= b)
}

function markdownFontifyCodeBlockNatively(lang: string | null, body: string): TextSpan[] {
  const mode = markdownGetLangMode(lang)
  if (!mode || !body) return [{ start: 0, end: body.length, face: "string" }]
  const scratch = new BufferModel({ name: "markdown-code-fontification", text: body, mode })
  const fontLock = modeFeature(mode, "fontLock")
  if (!fontLock) return [{ start: 0, end: body.length, face: "string" }]
  return fontLock(scratch)
}

function toggleBufferBoolean(
  buffer: BufferModel,
  current: () => boolean,
  set: (buffer: BufferModel, value: boolean) => void,
  prefixArgument: number | null | undefined,
): boolean {
  const next = prefixArgument == null
    ? !current()
    : prefixArgument > 0
  set(buffer, next)
  return next
}

export function markdownParseHeadings(text: string): MarkdownHeading[] {
  const lines = text.split("\n")
  const out: MarkdownHeading[] = []
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const atx = line.match(/^(\s*)(#{1,6})\s+(.*)$/)
    if (atx) {
      out.push({
        line: i,
        start: offset,
        end: offset + line.length,
        level: atx[2]!.length,
        title: atx[3] ?? "",
      })
    } else if (i + 1 < lines.length && line.trim()) {
      const next = lines[i + 1]!
      const setext = SETEXT_UNDERLINE_RE.exec(next)
      if (setext && !line.match(/^#{1,6}\s/)) {
        const level = setext[2]!.startsWith("=") ? 1 : 2
        out.push({ line: i, start: offset, end: offset + line.length, level, title: line.trim() })
      }
    }
    offset += line.length + 1
  }
  return out
}

const MARKDOWN_TOC_START = "<!-- markdown-toc start -->"
const MARKDOWN_TOC_END = "<!-- markdown-toc end -->"

export function markdownTocSlug(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
}

export function markdownTocText(text: string): string {
  const items = markdownParseHeadings(text).map(h => {
    const indent = "  ".repeat(Math.max(0, h.level - 1))
    const title = h.title.trim()
    return `${indent}- [${title}](#${markdownTocSlug(title)})`
  })
  return [MARKDOWN_TOC_START, ...items, MARKDOWN_TOC_END, ""].join("\n")
}

export function markdownTocBlockRange(text: string): { start: number; end: number } | null {
  const start = text.indexOf(MARKDOWN_TOC_START)
  if (start < 0) return null
  const endMarker = text.indexOf(MARKDOWN_TOC_END, start + MARKDOWN_TOC_START.length)
  if (endMarker < 0) return null
  let end = endMarker + MARKDOWN_TOC_END.length
  if (text[end] === "\r" && text[end + 1] === "\n") end += 2
  else if (text[end] === "\n") end += 1
  return { start, end }
}

export function markdownHeadingAtPoint(text: string, point: number): MarkdownHeading | null {
  const line = text.slice(0, point).split("\n").length - 1
  return markdownParseHeadings(text).find(h => h.line === line) ?? null
}

export function markdownSubtreeEndLine(headings: MarkdownHeading[], h: MarkdownHeading, lineCount: number): number {
  for (const next of headings) {
    if (next.line > h.line && next.level <= h.level) return next.line - 1
  }
  return lineCount - 1
}

function markdownChildren(headings: MarkdownHeading[], h: MarkdownHeading, lineCount: number): MarkdownHeading[] {
  const end = markdownSubtreeEndLine(headings, h, lineCount)
  return headings.filter(c => c.line > h.line && c.line <= end && c.level === h.level + 1)
}

function foldedRanges(buffer: BufferModel): FoldRange[] {
  return (buffer.locals.get(MARKDOWN_FOLDED_LOCAL) as FoldRange[] | undefined) ?? EMPTY_FOLD_RANGES
}

function subtreeStatusMap(buffer: BufferModel): Map<number, SubtreeCycle> {
  const existing = buffer.locals.get(MARKDOWN_SUBTREE_STATUS) as Map<number, SubtreeCycle> | undefined
  if (existing) return existing
  const map = new Map<number, SubtreeCycle>()
  buffer.locals.set(MARKDOWN_SUBTREE_STATUS, map)
  return map
}

function globalStatus(buffer: BufferModel): GlobalCycle {
  return (buffer.locals.get(MARKDOWN_GLOBAL_STATUS) as GlobalCycle | undefined) ?? 1
}

function setGlobalStatus(buffer: BufferModel, status: GlobalCycle): void {
  buffer.locals.set(MARKDOWN_GLOBAL_STATUS, status)
}

function mergeFoldRanges(ranges: FoldRange[]): FoldRange[] {
  const sorted = ranges.filter(([a, b]) => a <= b).sort((x, y) => x[0] - y[0])
  const merged: FoldRange[] = []
  for (const r of sorted) {
    const last = merged.at(-1)
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}

function setFolded(buffer: BufferModel, ranges: FoldRange[]): void {
  buffer.locals.set(MARKDOWN_FOLDED_LOCAL, mergeFoldRanges(ranges))
  buffer.locals.delete(MARKDOWN_FILTER_CACHE)
}

function hideSublevels(headings: MarkdownHeading[], maxLevel: number, lineCount: number): FoldRange[] {
  const ranges: FoldRange[] = []
  for (const h of headings) {
    if (h.level <= maxLevel) continue
    const end = markdownSubtreeEndLine(headings, h, lineCount)
    if (end > h.line) ranges.push([h.line + 1, end])
  }
  return ranges
}

function recomputeFoldRanges(buffer: BufferModel): FoldRange[] {
  const text = buffer.text
  const headings = markdownParseHeadings(text)
  const lines = text.split("\n")
  const lineCount = lines.length
  const headingLines = new Set(headings.map(h => h.line))
  const setextUnderlines = new Set<number>()
  for (let i = 0; i < lines.length - 1; i++) {
    if (SETEXT_UNDERLINE_RE.test(lines[i + 1]!) && lines[i]!.trim()) setextUnderlines.add(i + 1)
  }

  const ranges: FoldRange[] = []
  const g = globalStatus(buffer)
  if (g === 2) {
    for (let i = 0; i < lineCount; i++) {
      if (!headingLines.has(i) && !setextUnderlines.has(i)) ranges.push([i, i])
    }
  } else if (g === 3) {
    ranges.push(...hideSublevels(headings, 1, lineCount))
  }

  const status = subtreeStatusMap(buffer)
  for (const [line, cycle] of status) {
    const h = headings.find(x => x.line === line)
    if (!h) continue
    const end = markdownSubtreeEndLine(headings, h, lineCount)
    if (cycle === "folded") {
      if (end > h.line) ranges.push([h.line + 1, end])
    } else if (cycle === "children") {
      for (const child of markdownChildren(headings, h, lineCount)) {
        const childEnd = markdownSubtreeEndLine(headings, child, lineCount)
        if (childEnd > child.line) ranges.push([child.line + 1, childEnd])
      }
    }
  }
  return mergeFoldRanges(ranges)
}

function syncFoldRanges(buffer: BufferModel): void {
  setFolded(buffer, recomputeFoldRanges(buffer))
}

function mergeMarkupOps(ops: MarkupOp[]): MarkupOp[] {
  if (!ops.length) return []
  const sorted = [...ops].sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: MarkupOp[] = []
  for (const op of sorted) {
    const last = merged.at(-1)
    if (!last || op.start >= last.end) merged.push({ ...op })
    else if (op.end > last.end) last.end = op.end
  }
  return merged
}

function protectedInlineCodeRanges(line: string, lineStart: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    if (m.index == null) continue
    const innerStart = lineStart + m.index + 1
    out.push([innerStart, innerStart + m[1]!.length])
  }
  return out
}

function rangeProtected(start: number, end: number, protectedRanges: Array<[number, number]>): boolean {
  return protectedRanges.some(([a, b]) => start >= a && end <= b)
}

function pushMarkupHide(
  ops: MarkupOp[],
  start: number,
  end: number,
  protectedRanges: Array<[number, number]>,
  display = "",
): void {
  if (start >= end || rangeProtected(start, end, protectedRanges)) return
  ops.push({ start, end, display })
}

function markdownWordChar(ch: string | undefined): boolean {
  return ch != null && /[0-9A-Za-z_]/.test(ch)
}

function gfmIntrawordUnderscoreMarkup(line: string, start: number, markerLen: 1 | 2, matchLen: number): boolean {
  const closeStart = start + matchLen - markerLen
  return (markdownWordChar(line[start - 1]) && markdownWordChar(line[start + markerLen]))
    || (markdownWordChar(line[closeStart - 1]) && markdownWordChar(line[closeStart + markerLen]))
}

function collectInlineMarkupHides(
  line: string,
  lineStart: number,
  hideUrls: boolean,
  protectedRanges: Array<[number, number]>,
  ops: MarkupOp[],
  gfm = false,
): void {
  for (const m of line.matchAll(/!?\[([^\]]*)\]\(([^)]*)\)/g)) {
    if (m.index == null) continue
    const i = m.index
    const textEnd = i + 1 + (m[1]?.length ?? 0)
    const urlStart = textEnd + 2
    const urlEnd = urlStart + (m[2]?.length ?? 0)
    pushMarkupHide(ops, lineStart + i, lineStart + i + 1, protectedRanges)
    pushMarkupHide(ops, lineStart + textEnd, lineStart + urlStart, protectedRanges)
    if (hideUrls && m[2]) {
      pushMarkupHide(ops, lineStart + urlStart, lineStart + urlEnd, protectedRanges, URL_COMPOSE_CHAR)
    }
    pushMarkupHide(ops, lineStart + urlEnd, lineStart + urlEnd + 1, protectedRanges)
  }
  for (const m of line.matchAll(/!?\[([^\]\n]*)\]\[([^\]\n]*)\]/g)) {
    if (m.index == null) continue
    const i = m.index
    const textEnd = i + 1 + (m[1]?.length ?? 0)
    const labelStart = textEnd + 2
    const labelEnd = labelStart + (m[2]?.length ?? 0)
    pushMarkupHide(ops, lineStart + i, lineStart + i + 1, protectedRanges)
    pushMarkupHide(ops, lineStart + textEnd, lineStart + labelStart, protectedRanges)
    if (hideUrls && m[2]) {
      pushMarkupHide(ops, lineStart + labelStart, lineStart + labelEnd, protectedRanges, URL_COMPOSE_CHAR)
    } else {
      pushMarkupHide(ops, lineStart + labelStart, lineStart + labelEnd, protectedRanges)
    }
    pushMarkupHide(ops, lineStart + labelEnd, lineStart + labelEnd + 1, protectedRanges)
  }
  for (const m of line.matchAll(/<((?:https?:\/\/|mailto:)[^>]+)>/g)) {
    if (m.index == null) continue
    pushMarkupHide(ops, lineStart + m.index, lineStart + m.index + 1, protectedRanges)
    if (hideUrls) {
      pushMarkupHide(ops, lineStart + m.index + 1, lineStart + m.index + 1 + m[1]!.length, protectedRanges, URL_COMPOSE_CHAR)
    }
    pushMarkupHide(ops, lineStart + m.index + m[0].length - 1, lineStart + m.index + m[0].length, protectedRanges)
  }
  for (const m of line.matchAll(/\*\*(\S(?:.*?\S)?)\*\*/g)) {
    if (m.index == null) continue
    pushMarkupHide(ops, lineStart + m.index, lineStart + m.index + 2, protectedRanges)
    pushMarkupHide(ops, lineStart + m.index + m[0].length - 2, lineStart + m.index + m[0].length, protectedRanges)
  }
  for (const m of line.matchAll(/__(\S(?:.*?\S)?)__/g)) {
    if (m.index == null) continue
    if (gfm && gfmIntrawordUnderscoreMarkup(line, m.index, 2, m[0].length)) continue
    pushMarkupHide(ops, lineStart + m.index, lineStart + m.index + 2, protectedRanges)
    pushMarkupHide(ops, lineStart + m.index + m[0].length - 2, lineStart + m.index + m[0].length, protectedRanges)
  }
  for (const m of line.matchAll(/~~(\S(?:.*?\S)?)~~/g)) {
    if (m.index == null) continue
    if (!gfm) continue
    pushMarkupHide(ops, lineStart + m.index, lineStart + m.index + 2, protectedRanges)
    pushMarkupHide(ops, lineStart + m.index + m[0].length - 2, lineStart + m.index + m[0].length, protectedRanges)
  }
  for (const m of line.matchAll(/(?<!\*)\*(?!\*)(\S(?:.*?\S)?)\*(?!\*)/g)) {
    if (m.index == null) continue
    pushMarkupHide(ops, lineStart + m.index, lineStart + m.index + 1, protectedRanges)
    pushMarkupHide(ops, lineStart + m.index + m[0].length - 1, lineStart + m.index + m[0].length, protectedRanges)
  }
  for (const m of line.matchAll(/(?<!_)_(?!_)(\S(?:.*?\S)?)_(?!_)/g)) {
    if (m.index == null) continue
    if (gfm && gfmIntrawordUnderscoreMarkup(line, m.index, 1, m[0].length)) continue
    pushMarkupHide(ops, lineStart + m.index, lineStart + m.index + 1, protectedRanges)
    pushMarkupHide(ops, lineStart + m.index + m[0].length - 1, lineStart + m.index + m[0].length, protectedRanges)
  }
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    if (m.index == null) continue
    pushMarkupHide(ops, lineStart + m.index, lineStart + m.index + 1, protectedRanges)
    pushMarkupHide(ops, lineStart + m.index + m[0].length - 1, lineStart + m.index + m[0].length, protectedRanges)
  }
}

function collectMarkupHides(text: string, hideUrls: boolean, gfm = false): MarkupOp[] {
  const ops: MarkupOp[] = []
  const lines = text.split("\n")
  const blocks = parseFencedCodeBlocks(text)
  const codeBodyRanges: Array<[number, number]> = []
  const lineStarts: number[] = []
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    lineStarts[i] = offset
    offset += lines[i]!.length + 1
  }
  for (const block of blocks) {
    if (block.bodyEnd > block.bodyStart) codeBodyRanges.push([block.bodyStart, block.bodyEnd])
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!
    const lineStart = lineStarts[lineIdx]!
    const lineEnd = lineStart + line.length
    if (codeBodyRanges.some(([a, b]) => lineStart >= a && lineEnd <= b)) continue

    const atx = line.match(/^(\s*)(#{1,6})(\s+)(.*?)(\s+#+\s*)?$/)
    if (atx) {
      const markerStart = lineStart + atx[1]!.length
      const titleStart = markerStart + atx[2]!.length + atx[3]!.length
      pushMarkupHide(ops, markerStart, titleStart, [])
      if (atx[5]) {
        const closeStart = lineEnd - atx[5].length
        pushMarkupHide(ops, closeStart, lineEnd, [])
      }
    } else if (SETEXT_UNDERLINE_RE.test(line) && lineIdx > 0 && lines[lineIdx - 1]!.trim()) {
      pushMarkupHide(ops, lineStart, lineEnd, [])
    }

    const bq = line.match(/^(\s*)(>+\s?)/)
    if (bq) {
      const markerStart = lineStart + bq[1]!.length
      pushMarkupHide(ops, markerStart, markerStart + bq[2]!.length, [], "")
    }

    const list = line.match(/^(\s*)([-*+]|\d+[.)])\s+/)
    if (list) {
      const markerStart = lineStart + list[1]!.length
      const markerEnd = lineStart + list[0]!.length
      const bullet = /^\d/.test(list[2]!) ? `${list[2]} ` : `${LIST_BULLET} `
      pushMarkupHide(ops, markerStart, markerEnd, [], bullet)
    }

    if (/^(\s*)([-*_])\1{2,}\s*$/.test(line)) {
      const hr = "─".repeat(Math.max(3, line.trim().length))
      pushMarkupHide(ops, lineStart, lineEnd, [], hr)
    }

    const protectedRanges = protectedInlineCodeRanges(line, lineStart)
    collectInlineMarkupHides(line, lineStart, hideUrls, protectedRanges, ops, gfm)
  }
  return mergeMarkupOps(ops)
}

function renderLineWithMarkupMap(line: string, lineStart: number, ops: MarkupOp[]): LineRenderMap {
  const out: string[] = []
  const bufToDisp = new Array<number>(line.length + 1)
  const dispToBuf: number[] = []
  let opIdx = 0
  let col = 0
  let disp = 0
  while (col < line.length) {
    while (opIdx < ops.length && ops[opIdx]!.end <= lineStart + col) opIdx++
    const op = ops[opIdx]
    if (op && op.start === lineStart + col) {
      const endCol = Math.min(line.length, op.end - lineStart)
      for (let c = col; c < endCol; c++) bufToDisp[c] = disp
      for (let i = 0; i < op.display.length; i++) {
        out.push(op.display[i]!)
        dispToBuf[disp++] = col
      }
      col = endCol
      continue
    }
    bufToDisp[col] = disp
    out.push(line[col]!)
    dispToBuf[disp++] = col
    col++
  }
  bufToDisp[line.length] = disp
  dispToBuf[disp] = line.length
  return { text: out.join(""), bufToDisp, dispToBuf }
}

export function markdownDisplayFilter(buffer: BufferModel): DisplayFilterResult | null {
  const ranges = foldedRanges(buffer)
  const hideMarkup = markdownHideMarkup(buffer)
  const hideUrls = markdownHideUrls(buffer)
  if (!ranges.length && !hideMarkup) return null
  const src = buffer.text
  const cached = buffer.locals.get(MARKDOWN_FILTER_CACHE) as DisplayFilterCache | undefined
  if (cached
    && cached.text === src
    && cached.ranges === ranges
    && cached.hideMarkup === hideMarkup
    && cached.hideUrls === hideUrls) return cached.result

  const lines = src.split("\n")
  const L = lines.length
  const foldHidden = new Uint8Array(L)
  const skipHidden = new Uint8Array(L)
  for (const [a, b] of ranges)
    for (let i = Math.max(0, a); i <= b && i < L; i++) foldHidden[i] = 1

  const fenced = parseFencedCodeBlocks(src)
  const markupOps = hideMarkup ? collectMarkupHides(src, hideUrls, markdownIsGfmMode(buffer)) : []
  if (hideMarkup) {
    for (const block of fenced) {
      skipHidden[block.openLine] = 1
      // Closing fence: drop the delimiter line but keep the paragraph break after the block.
      skipHidden[block.closeLine] = 2
    }
  }

  const bufStart: number[] = new Array(L)
  const lineLen: number[] = new Array(L)
  for (let o = 0, i = 0; i < L; i++) { bufStart[i] = o; lineLen[i] = lines[i]!.length; o += lineLen[i]! + 1 }
  const opsByLine: MarkupOp[][] = Array.from({ length: L }, () => [])
  if (hideMarkup && markupOps.length) {
    let opIdx = 0
    for (let i = 0; i < L; i++) {
      const start = bufStart[i]!
      const end = start + lineLen[i]!
      while (opIdx < markupOps.length && markupOps[opIdx]!.end <= start) opIdx++
      for (let j = opIdx; j < markupOps.length && markupOps[j]!.start < end; j++) {
        if (markupOps[j]!.end > start) opsByLine[i]!.push(markupOps[j]!)
      }
    }
  }

  const dispStart: number[] = new Array(L)
  const displayLines: DisplayLineMap[] = []
  const lineDisplayMaps: Array<DisplayLineMap | undefined> = new Array(L)
  const parts: string[] = []
  let dispLen = 0
  let lastVisibleEnd = 0
  for (let i = 0; i < L; i++) {
    if (foldHidden[i] || skipHidden[i] === 1) { dispStart[i] = lastVisibleEnd; continue }
    if (skipHidden[i] === 2) {
      dispStart[i] = lastVisibleEnd
      const entry = { line: i, dispStart: dispLen, displayLen: 0 }
      displayLines.push(entry)
      lineDisplayMaps[i] = entry
      parts.push("\n")
      dispLen += 1
      lastVisibleEnd = dispLen
      continue
    }
    if (dispLen > 0) { parts.push("\n"); dispLen += 1 }
    dispStart[i] = dispLen
    const rendered = hideMarkup
      ? renderLineWithMarkupMap(lines[i]!, bufStart[i]!, opsByLine[i]!)
      : null
    const renderedText = rendered?.text ?? lines[i]!
    const entry = {
      line: i,
      dispStart: dispLen,
      displayLen: renderedText.length,
      bufToDisp: rendered?.bufToDisp,
      dispToBuf: rendered?.dispToBuf,
    }
    displayLines.push(entry)
    lineDisplayMaps[i] = entry
    parts.push(renderedText)
    dispLen += renderedText.length
    lastVisibleEnd = dispLen
    if (i + 1 < L && foldHidden[i + 1]) { parts.push("..."); dispLen += 3 }
  }
  const text = parts.join("")

  const map = (n: number): number => {
    const nn = Math.max(0, Math.min(n, src.length))
    let lo = 0, hi = L
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (bufStart[mid]! <= nn) lo = mid + 1; else hi = mid
    }
    const i = lo - 1
    if (foldHidden[i] || skipHidden[i]) return dispStart[i]! // 1 = invisible, 2 = paragraph break
    const col = nn - bufStart[i]!
    if (!hideMarkup) return dispStart[i]! + Math.min(col, lineLen[i]!)
    const rendered = lineDisplayMaps[i]
    return dispStart[i]! + (rendered?.bufToDisp?.[Math.min(col, lineLen[i]!)] ?? Math.min(col, lineLen[i]!))
  }
  const unmap = (n: number): number => {
    const nn = Math.max(0, Math.min(n, text.length))
    if (!displayLines.length) return 0
    let lo = 0, hi = displayLines.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (displayLines[mid]!.dispStart <= nn) lo = mid + 1; else hi = mid
    }
    const entry = displayLines[Math.max(0, lo - 1)]!
    const col = Math.max(0, Math.min(nn - entry.dispStart, entry.displayLen))
    const lineStart = bufStart[entry.line] ?? src.length
    const lineLength = lineLen[entry.line] ?? 0
    const bufCol = entry.dispToBuf?.[col] ?? Math.min(col, lineLength)
    return Math.max(0, Math.min(lineStart + bufCol, src.length))
  }
  const result = { text, map, unmap }
  buffer.locals.set(MARKDOWN_FILTER_CACHE, {
    text: src,
    ranges,
    hideMarkup,
    hideUrls,
    result,
  } satisfies DisplayFilterCache)
  return result
}

function cycleGlobalVisibility(editor: Editor, buffer: BufferModel): void {
  const prev = globalStatus(buffer)
  let next: GlobalCycle
  let message: string
  if (prev === 2) { next = 3; message = "CONTENTS" }
  else if (prev === 3) { next = 1; message = "SHOW ALL" }
  else { next = 2; message = "OVERVIEW" }
  setGlobalStatus(buffer, next)
  subtreeStatusMap(buffer).clear()
  syncFoldRanges(buffer)
  editor.message(message)
}

function trackIndentCommand(buffer: BufferModel, name: string): void {
  buffer.locals.set(MARKDOWN_LAST_INDENT, { name, point: buffer.point })
}

function markdownListDepthBefore(text: string, lineStart: number): number {
  const lines = text.slice(0, lineStart).split("\n")
  const levels: number[] = []
  let previousBlank = true

  for (const line of lines) {
    const marker = line.match(LIST_RE)
    const indent = line.match(/^\s*/)?.[0].length ?? 0
    const startsBaseline = ATX_HEADER_RE.test(line.trim())
      || SETEXT_UNDERLINE_RE.test(line.trim())
      || (indent === 0 && !marker && previousBlank && line.trim().length > 0)
    if (startsBaseline) levels.length = 0

    if (marker) {
      if (!levels.length) levels.push(indent)
      else if (indent >= levels[0]! + TAB_WIDTH) levels.unshift(indent)
      else if (indent < levels[0]!) {
        while (levels.length > 1 && indent < levels[1]! + TAB_WIDTH) levels.shift()
      }
    } else if (levels.length && indent < levels[0]!) {
      while (levels.length > 1 && indent < levels[1]! + TAB_WIDTH) levels.shift()
    }
    previousBlank = line.trim().length === 0
  }

  return levels.length
}

export function markdownCalcIndents(text: string, lineStart: number): number[] {
  const positions: number[] = []
  const prev = previousLineStart(text, lineStart)
  const prevIndent = prev == null ? 0 : lineIndent(text, prev)
  positions.push(prevIndent)

  if (prev != null) {
    const prevLine = text.slice(prev, lineEnd(text, prev))
    const listMatch = prevLine.match(LIST_RE)
    if (listMatch) {
      const markerEnd = prev + (listMatch[0]?.length ?? 0)
      positions.push(markerEnd - prev)
    }
  }

  const line = text.slice(lineStart, lineEnd(text, lineStart))
  if (BLOCKQUOTE_RE.test(line)) {
    const match = line.match(BLOCKQUOTE_RE)
    if (match) positions.push((match[1]?.length ?? 0) + 2)
  }
  if (FENCED_CODE_RE.test(line.trim())) positions.push(prevIndent + TAB_WIDTH)
  // `markdown-pre-indentation` contributes one four-column block plus one
  // for each enclosing list level. This is why TAB on a flat list cycles
  // through 0, marker-width, 4, 8 instead of wrapping at column 4.
  positions.push(TAB_WIDTH * (1 + markdownListDepthBefore(text, lineStart)))
  positions.push(prevIndent + TAB_WIDTH)
  if (prevIndent > TAB_WIDTH) positions.push(prevIndent - TAB_WIDTH)

  let cursor = lineStart
  while (cursor > 0) {
    const start = previousLineStart(text, cursor)
    if (start == null) break
    const body = text.slice(start, lineEnd(text, start))
    const list = body.match(LIST_RE)
    if (list) positions.push(lineIndent(text, start))
    if (ATX_HEADER_RE.test(body.trim())) break
    cursor = start
  }

  positions.push(0)
  return positions
}

function sortedUniquePositions(positions: number[]): number[] {
  return [...new Set(positions)].sort((a, b) => a - b)
}

export function markdownIndentLine(buffer: BufferModel, cycle = false): void {
  const line = buffer.lineBoundsAt()
  const positions = markdownCalcIndents(buffer.text, line.start)
  const content = line.text.replace(/^\s*/, "")
  const currentIndent = line.text.length - content.length
  const oldPoint = buffer.point

  let desired = positions[0] ?? 0
  if (content.length === 0) {
    const prev = previousLineStart(buffer.text, line.start)
    if (prev != null) {
      const prevLine = buffer.text.slice(prev, lineEnd(buffer.text, prev))
      const listMatch = prevLine.match(LIST_RE)
      if (listMatch) desired = listMatch[0]?.length ?? desired
    }
  }
  if (cycle || buffer.locals.get(MARKDOWN_CYCLE_REPEAT) === true) {
    const cyclePositions = sortedUniquePositions(positions)
    desired = cyclePositions.find(pos => pos > currentIndent) ?? cyclePositions[0] ?? desired
  }

  buffer.replaceRange(line.start, line.end, " ".repeat(desired) + content)
  buffer.point = Math.max(oldPoint + desired - currentIndent, line.start)
}

function markdownOutdentLine(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const positions = sortedUniquePositions(markdownCalcIndents(buffer.text, line.start))
  const content = line.text.replace(/^\s*/, "")
  const currentIndent = line.text.length - content.length
  const oldPoint = buffer.point
  let desired = 0
  for (const pos of positions) {
    if (pos < currentIndent) desired = pos
  }
  buffer.replaceRange(line.start, line.end, " ".repeat(desired) + content)
  buffer.point = Math.max(oldPoint + desired - currentIndent, line.start)
}

function markdownHeaderFace(level: number): FaceName {
  return `markdown-header-face-${Math.min(6, Math.max(1, level))}` as FaceName
}

function overlayMarkdownHeaderFaces(text: string, spans: TextSpan[], range?: FontLockRange): TextSpan[] {
  const headings = markdownParseHeadingsInRange(text, range)
  if (!headings.length) return spans
  const headerSpans = headings.map(h => ({
    start: h.start,
    end: h.end,
    face: markdownHeaderFace(h.level),
  }))
  const filtered = spans.filter(span =>
    !headings.some(h => span.start >= h.start && span.end <= h.end),
  )
  return [...filtered, ...headerSpans].sort((a, b) => a.start - b.start || a.end - b.end)
}

function markdownParseHeadingsInRange(text: string, range?: FontLockRange): MarkdownHeading[] {
  if (!range) return markdownParseHeadings(text)
  const start = Math.max(0, range.start)
  const lines = text.slice(start, range.end).split("\n")
  const headings: MarkdownHeading[] = []
  let offset = start
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const atx = line.match(/^(\s*)(#{1,6})\s+(.*)$/)
    if (atx) {
      headings.push({
        line: range.startLine + i,
        start: offset,
        end: offset + line.length,
        level: atx[2]!.length,
        title: atx[3] ?? "",
      })
    } else if (i + 1 < lines.length && line.trim()) {
      const setext = SETEXT_UNDERLINE_RE.exec(lines[i + 1]!)
      if (setext && !line.match(/^#{1,6}\s/)) {
        headings.push({
          line: range.startLine + i,
          start: offset,
          end: offset + line.length,
          level: setext[2]!.startsWith("=") ? 1 : 2,
          title: line.trim(),
        })
      }
    }
    offset += line.length + 1
  }
  return headings
}

function fenceLineSpan(buffer: BufferModel, line: number): TextSpan | null {
  if (line < 0 || line >= buffer.lineCount) return null
  const [start, end] = buffer.lineBounds(line)
  return { start, end, face: "string" }
}

function markdownStrikethroughSpans(text: string, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const protectedRanges: Array<readonly [number, number]> = parseFencedCodeBlocks(text).map(block => [block.bodyStart, block.bodyEnd] as const)
  let offset = 0
  for (const line of text.split("\n")) {
    protectedRanges.push(...protectedInlineCodeRanges(line, offset))
    offset += line.length + 1
  }
  for (const match of text.matchAll(/~~(\S(?:.*?\S)?)~~/g)) {
    if (match.index == null) continue
    const start = match.index
    const end = start + match[0].length
    if (range && (end < range.start || start > range.end)) continue
    if (spanInsideRegions(start, end, protectedRanges)) continue
    spans.push({ start, end: start + 2, face: "markdown-markup" as FaceName })
    spans.push({ start: start + 2, end: end - 2, face: "markdown-strikethrough" as FaceName })
    spans.push({ start: end - 2, end, face: "markdown-markup" as FaceName })
  }
  return spans
}

function gfmUnderscoreEmphasisSpan(text: string, span: TextSpan): boolean {
  const face = String(span.face)
  if (face !== "markdown-emphasis" && face !== "markdown-strong") return false
  const markerLen = face === "markdown-strong" ? 2 : 1
  const marker = "_".repeat(markerLen)
  if (text.slice(span.start, span.start + markerLen) !== marker) return false
  if (text.slice(span.end - markerLen, span.end) !== marker) return false
  return gfmIntrawordUnderscoreMarkup(text, span.start, markerLen as 1 | 2, span.end - span.start)
}

function markdownFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const gfm = markdownIsGfmMode(buffer)
  const mdLang = gfm ? "gfm" : "markdown"
  const blocks = parseFencedCodeBlocks(buffer.text).filter(block => !range || block.bodyEnd >= range.start && block.bodyStart <= range.end)
  const native = markdownFontifyCodeBlocksNatively(buffer)
  const bodyRegions = blocks.map(b => [b.bodyStart, b.bodyEnd] as const)

  let spans = treeSitterFontLock(mdLang, buffer, range)
  if (gfm) spans = spans.filter(span => !gfmUnderscoreEmphasisSpan(buffer.text, span))
  if (bodyRegions.length) {
    spans = spans.filter(s => !spanInsideRegions(s.start, s.end, bodyRegions))
  }

  for (const block of blocks) {
    const openSpan = fenceLineSpan(buffer, block.openLine)
    const closeSpan = fenceLineSpan(buffer, block.closeLine)
    if (openSpan) spans.push(openSpan)
    if (closeSpan) spans.push(closeSpan)

    const bodyStart = range ? Math.max(block.bodyStart, range.start) : block.bodyStart
    const bodyEnd = range ? Math.min(block.bodyEnd, range.end) : block.bodyEnd
    const body = buffer.text.slice(bodyStart, bodyEnd)
    if (!body) continue
    if (native) {
      for (const span of markdownFontifyCodeBlockNatively(block.lang, body)) {
        spans.push({
          start: bodyStart + span.start,
          end: bodyStart + span.end,
          face: span.face,
        })
      }
    } else {
      spans.push({ start: bodyStart, end: bodyEnd, face: "string" })
    }
  }

  if (gfm) spans.push(...markdownStrikethroughSpans(buffer.text, range))
  spans = overlayMarkdownLinkFaces(buffer.text, spans, range, gfm)
  return overlayMarkdownHeaderFaces(buffer.text, spans, range)
}

function overlayMarkdownLinkFaces(text: string, spans: TextSpan[], range?: FontLockRange, includeBare = false): TextSpan[] {
  const linkSpans = markdownLinks(text, includeBare)
    .filter(link => !range || (link.end >= range.start && link.start <= range.end))
    .map(link => ({ start: link.start, end: link.end, face: "markdown-link" as FaceName }))
  if (!linkSpans.length) return spans
  return [...spans, ...linkSpans].sort((a, b) => a.start - b.start || a.end - b.end)
}

function applyMarkdownFaceRemap(buffer: BufferModel): void {
  faceRemapAddRelative(buffer, "default", { family: VARIABLE_PITCH_FAMILY })
  // Code spans / fences / fenced bodies all font-lock as `string`; pin them to
  // fixed-pitch so they stay monospace under the variable-pitch default remap.
  faceRemapAddRelative(buffer, "string", { family: FIXED_PITCH_FAMILY })
  for (const [face, scale] of MARKDOWN_HEADER_FACES) {
    faceRemapAddRelative(buffer, face, { heightScale: scale })
  }
  buffer.minorModes.delete("linum-mode")
  buffer.locals.set(MARKDOWN_FILL_COLUMN, getCustom<number>("markdown-fill-column") ?? 100)
  buffer.locals.set(MARKDOWN_VISUAL_FILL, true)
  buffer.locals.set("markdown-visual-fill-column-center-text", getCustom<boolean>("markdown-visual-fill-column-center-text") ?? true)
  buffer.locals.set("word-wrap", getCustom<boolean>("word-wrap") ?? true)
  buffer.locals.set("adaptive-wrap-prefix-mode", true)
}

function applyGfmFaceRemap(buffer: BufferModel): void {
  applyMarkdownFaceRemap(buffer)
  buffer.locals.set("word-wrap", true)
  buffer.locals.set("markdown-wiki-link-search-subdirectories", true)
}

function applyMarkdownViewModeEnter(buffer: BufferModel): void {
  applyMarkdownFaceRemap(buffer)
  if (getCustom<boolean>("markdown-hide-markup-in-view-modes") ?? true) {
    setMarkdownHideMarkup(buffer, true)
  }
}

function applyGfmViewModeEnter(buffer: BufferModel): void {
  applyGfmFaceRemap(buffer)
  if (getCustom<boolean>("markdown-hide-markup-in-view-modes") ?? true) {
    setMarkdownHideMarkup(buffer, true)
  }
}

function markdownToggleCheckboxAtPoint(buffer: BufferModel, point: number): boolean {
  return markdownToggleCheckbox(buffer, point, true).changed
}

function markdownToggleCheckbox(buffer: BufferModel, point: number, requireCheckboxHit = false): MarkdownEditResult {
  const clamped = Math.max(0, Math.min(point, buffer.text.length))
  const lineStart = buffer.text.lastIndexOf("\n", Math.max(0, clamped - 1)) + 1
  const nextNewline = buffer.text.indexOf("\n", lineStart)
  const lineEnd = nextNewline === -1 ? buffer.text.length : nextNewline
  const line = buffer.text.slice(lineStart, lineEnd)
  const match = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/.exec(line)
  if (!match) return { changed: false, message: "No checkbox at point" }
  const markerStart = lineStart + match[1]!.length - 1
  const markerEnd = markerStart + 3
  if (requireCheckboxHit && (clamped < markerStart || clamped > markerEnd)) {
    return { changed: false, message: "No checkbox at point" }
  }
  const checkPoint = lineStart + match[1]!.length
  const next = match[2] === " " ? "x" : " "
  buffer.replaceRange(checkPoint, checkPoint + 1, next)
  buffer.point = checkPoint
  return { changed: true, message: next === "x" ? "Checked checkbox" : "Unchecked checkbox" }
}

function bindMarkdownModeMap(keymap: Keymap): void {
  keymap.bind("return", "markdown-enter-key")
  keymap.bind("enter", "markdown-enter-key")
  keymap.bind("C-m", "markdown-enter-key")
  keymap.bind("tab", "markdown-cycle")
  keymap.bind("C-i", "markdown-cycle")
  keymap.bind("S-tab", "markdown-shifttab")
  keymap.bind("backspace", "markdown-outdent-or-delete")
  keymap.bind("C-c >", "markdown-indent-region")
  keymap.bind("C-c <", "markdown-outdent-region")
  keymap.bind("C-c C-l", "markdown-insert-link")
  keymap.bind("C-c C-k", "markdown-kill-thing-at-point")
  keymap.bind("C-c C-d", "markdown-do")
  keymap.bind("C-c C-c e", "markdown-export")
  keymap.bind("C-c C-c p", "markdown-preview")
  keymap.bind("C-c C-c o", "markdown-open")
  keymap.bind("C-c C-c c", "markdown-check-refs")
  keymap.bind("C-c C-s t", "markdown-insert-table")
  keymap.bind("C-c C--", "markdown-promote")
  keymap.bind("C-c C-=", "markdown-demote")
  keymap.bind("M-left", "markdown-promote")
  keymap.bind("M-right", "markdown-demote")
  keymap.bind("M-up", "markdown-move-up")
  keymap.bind("M-down", "markdown-move-down")
  keymap.bind("C-c left", "markdown-promote")
  keymap.bind("C-c right", "markdown-demote")
  keymap.bind("C-c up", "markdown-move-up")
  keymap.bind("C-c down", "markdown-move-down")
  keymap.bind("S-M-left", "markdown-promote-subtree")
  keymap.bind("M-S-left", "markdown-promote-subtree")
  keymap.bind("S-M-right", "markdown-demote-subtree")
  keymap.bind("M-S-right", "markdown-demote-subtree")
  keymap.bind("C-c C-n", "markdown-outline-next")
  keymap.bind("C-c C-p", "markdown-outline-previous")
  keymap.bind("C-c C-f", "markdown-outline-next-same-level")
  keymap.bind("C-c C-b", "markdown-outline-previous-same-level")
  keymap.bind("C-c C-u", "markdown-outline-up")
  keymap.bind("C-c C-j", "markdown-insert-list-item")
  keymap.bind("M-RET", "markdown-insert-list-item")
  keymap.bind("C-c C-x [", "markdown-insert-gfm-checkbox")
  keymap.bind("C-c C-x C-x", "markdown-toggle-gfm-checkbox")
  keymap.bind("C-c -", "markdown-insert-hr")
  keymap.bind("C-c C-o", "markdown-follow-thing-at-point")
  keymap.bind("C-c C-t 1", "markdown-insert-header-atx-1")
  keymap.bind("C-c C-t 2", "markdown-insert-header-atx-2")
  keymap.bind("C-c C-t 3", "markdown-insert-header-atx-3")
  keymap.bind("C-c C-t 4", "markdown-insert-header-atx-4")
  keymap.bind("C-c C-t 5", "markdown-insert-header-atx-5")
  keymap.bind("C-c C-t 6", "markdown-insert-header-atx-6")
  keymap.bind("C-c C-t !", "markdown-insert-header-setext-1")
  keymap.bind("C-c C-t @", "markdown-insert-header-setext-2")
  keymap.bind("C-c C-t h", "markdown-insert-header-dwim")
  keymap.bind("C-a", "markdown-beginning-of-line")
  keymap.bind("C-e", "markdown-end-of-line")
  keymap.bind("M-{", "markdown-backward-paragraph")
  keymap.bind("M-}", "markdown-forward-paragraph")
  keymap.bind("esc {", "markdown-backward-paragraph")
  keymap.bind("esc }", "markdown-forward-paragraph")
  keymap.bind("M-n", "markdown-next-link")
  keymap.bind("M-p", "markdown-previous-link")
  // C-c C-s style prefix (markdown-mode-style-map)
  keymap.bind("C-c C-s b", "markdown-insert-bold")
  keymap.bind("C-c C-s i", "markdown-insert-italic")
  keymap.bind("C-c C-s c", "markdown-insert-code")
  keymap.bind("C-c C-s C", "markdown-insert-gfm-code-block")
  keymap.bind("C-c '", "markdown-edit-code-block")
  keymap.bind("C-c C-s f", "markdown-insert-footnote")
  keymap.bind("C-c C-s q", "markdown-insert-blockquote")
  keymap.bind("C-c C-s -", "markdown-insert-hr")
  keymap.bind("C-c C-s 1", "markdown-insert-header-atx-1")
  keymap.bind("C-c C-s 2", "markdown-insert-header-atx-2")
  keymap.bind("C-c C-s 3", "markdown-insert-header-atx-3")
  keymap.bind("C-c C-s 4", "markdown-insert-header-atx-4")
  keymap.bind("C-c C-s 5", "markdown-insert-header-atx-5")
  keymap.bind("C-c C-s 6", "markdown-insert-header-atx-6")
  keymap.bind("C-c C-x C-m", "markdown-toggle-markup-hiding")
  keymap.bind("C-c C-x C-l", "markdown-toggle-url-hiding")
  keymap.bind("C-c C-x C-i", "markdown-toggle-inline-images")
  keymap.bind("C-c C-x C-f", "markdown-toggle-fontify-code-blocks-natively")
  // markdown-toc has no default binding upstream; "T" would collide with the
  // "t" insert-table binding since key lookup case-folds shifted letters.
}

function markdownGfmKnownLanguages(): string[] {
  const langs = new Set(DEFAULT_GFM_CODE_LANGUAGES)
  const modeMap = getCustom<Array<[string, string]>>("markdown-code-lang-modes") ?? []
  for (const entry of modeMap) {
    const lang = entry[0]
    if (typeof lang === "string" && lang) langs.add(lang)
  }
  return [...langs].sort((a, b) => a.localeCompare(b))
}

function rememberGfmLanguage(buffer: BufferModel, language: string): void {
  const lang = language.trim()
  if (!lang) return
  const local = buffer.locals.get(MARKDOWN_GFM_LANGUAGE_HISTORY) as string[] | undefined
  const history = local ? [...local] : [...(getCustom<string[]>(MARKDOWN_GFM_LANGUAGE_HISTORY) ?? [])]
  const existing = history.indexOf(lang)
  if (existing >= 0) history.splice(existing, 1)
  history.unshift(lang)
  buffer.locals.set(MARKDOWN_GFM_LANGUAGE_HISTORY, history)
}

async function readGfmCodeBlockLanguage(editor: Editor, buffer: BufferModel, args: string[]): Promise<string | null> {
  const explicit = args[0]
  const language = explicit != null
    ? explicit
    : await editor.completingRead("Language: ", {
      collection: markdownGfmKnownLanguages(),
      history: MARKDOWN_GFM_LANGUAGE_HISTORY,
    })
  if (language == null) return null
  rememberGfmLanguage(buffer, language)
  return language.trim()
}

function insertGfmCodeBlock(buffer: BufferModel, language: string, replaceLine = false): void {
  const lang = language.trim()
  const opening = lang ? `\`\`\`${lang}` : "```"
  const line = buffer.lineBoundsAt()
  const hasLineBreak = line.end < buffer.text.length && buffer.text[line.end] === "\n"
  const block = `${opening}\n\n\`\`\`${hasLineBreak ? "" : "\n"}`
  const bodyPointOffset = opening.length + 1
  if (replaceLine || !line.text.trim()) {
    buffer.replaceRange(line.start, line.end, block)
    buffer.point = line.start + bodyPointOffset
    return
  }
  const start = buffer.point
  buffer.insert(`\n${block}`)
  buffer.point = start + 1 + bodyPointOffset
}

async function maybeInsertElectricGfmCodeBlock(
  editor: Editor,
  buffer: BufferModel,
  args: string[],
  keyEvent: { sequence?: string } | null,
): Promise<void> {
  const inserted = args[0] ?? keyEvent?.sequence ?? editor.lastKeyEvent?.sequence
  if (inserted !== "`") return
  if (buffer.mode !== "gfm") return
  if (!(getCustom<boolean>("markdown-gfm-use-electric-backquote") ?? true)) return
  const line = buffer.lineBoundsAt(Math.max(0, buffer.point - 1))
  if (buffer.point !== line.start + 3) return
  if (buffer.text.slice(line.start, buffer.point) !== "```") return
  const language = await readGfmCodeBlockLanguage(editor, buffer, [])
  if (language == null) return
  insertGfmCodeBlock(buffer, language, true)
  editor.message("Inserted GFM code block")
}

let gfmBackquoteAdviceId: string | undefined

function installMarkdownCommands(editor: Editor, deps: MarkdownDeps): void {
  editor.command("markdown-enter-key", ({ buffer, editor }) => {
    trackIndentCommand(buffer, "markdown-enter-key")
    const indentOnEnter = getCustom<boolean | string>("markdown-indent-on-enter") ?? true
    const lineBefore = buffer.lineAt(buffer.point)
    const trimPreviousLine = () => {
      if (!(getCustom<boolean>("markdown-trim-trailing-whitespace-on-enter") ?? false)) return
      const [start, end] = buffer.lineBounds(lineBefore)
      const text = buffer.text.slice(start, end)
      const trimmed = text.replace(/\s+$/, "")
      if (trimmed.length < text.length) buffer.replaceRange(start + trimmed.length, end, "")
    }
    const line = buffer.lineBoundsAt()
    const emptyList = markdownEmptyListItem(line.text)
    if (indentOnEnter === "indent-and-new-item" && emptyList) {
      const hasLineBreak = line.end < buffer.text.length && buffer.text[line.end] === "\n"
      buffer.replaceRange(line.start, line.end, "")
      buffer.point = line.start
      if (!hasLineBreak) buffer.insert("\n")
      trimPreviousLine()
      return
    }
    if (indentOnEnter === "indent-and-new-item" && markdownNonEmptyListItem(line.text)) {
      insertMarkdownListItem(buffer)
      trimPreviousLine()
      editor.message("Inserted list item")
      return
    }
    buffer.insert("\n")
    if (indentOnEnter !== false) markdownIndentLine(buffer)
    trimPreviousLine()
    editor.message("New line")
  }, "Insert a newline and indent like `markdown-mode`.")

  editor.command("jemacs-clear-whitespace-and-newline-and-indent", async ({ editor, buffer }) => {
    const lineBefore = buffer.lineAt(buffer.point)
    await editor.run("markdown-enter-key")
    const [start, end] = buffer.lineBounds(lineBefore)
    const lineText = buffer.text.slice(start, end)
    const trimmed = lineText.replace(/\s+$/, "")
    if (trimmed.length < lineText.length) {
      buffer.replaceRange(start + trimmed.length, end, "")
    }
    const [newStart] = buffer.lineBounds(lineBefore + 1)
    buffer.point = newStart
  }, "RET in markdown: newline, trim trailing space on previous line, return.")

  editor.command("markdown-indent-line", ({ buffer }) => {
    trackIndentCommand(buffer, "markdown-indent-line")
    markdownIndentLine(buffer)
  }, "Indent the current line using Markdown heuristics.")

  editor.command("markdown-cycle", async ({ editor, buffer, prefixArgument }) => {
    if (prefixArgument != null) {
      cycleGlobalVisibility(editor, buffer)
      return
    }

    if (markdownInTable(buffer)) {
      const result = markdownTableForwardCell(buffer)
      editor.message(result.message)
      return
    }

    const heading = markdownHeadingAtPoint(buffer.text, buffer.point)
    if (heading) {
      const headings = markdownParseHeadings(buffer.text)
      const lc = buffer.text.split("\n").length
      const subEnd = markdownSubtreeEndLine(headings, heading, lc)
      const status = subtreeStatusMap(buffer)
      const prev = status.get(heading.line)
      if (subEnd <= heading.line) {
        editor.message("EMPTY ENTRY")
        status.delete(heading.line)
      } else if (prev === "children") {
        status.set(heading.line, "subtree")
        editor.message("SUBTREE")
      } else if (prev === "folded") {
        status.set(heading.line, "children")
        editor.message("CHILDREN")
      } else {
        status.set(heading.line, "folded")
        editor.message("FOLDED")
      }
      syncFoldRanges(buffer)
      return
    }

    // GNU markdown-mode's `markdown-indent-line` cycles whenever the current
    // command is `markdown-cycle`, including the first TAB. The old boolean
    // only cycled after a preceding TAB, leaving Jemacs one step behind.
    buffer.locals.set(MARKDOWN_CYCLE_REPEAT, true)
    try {
      await editor.run("indent-for-tab-command")
    } finally {
      buffer.locals.delete(MARKDOWN_CYCLE_REPEAT)
    }
    trackIndentCommand(buffer, "markdown-cycle")
  }, "Cycle heading visibility, or indent when not on a heading.")

  editor.command("markdown-shifttab", ({ editor, buffer }) => {
    if (markdownInTable(buffer)) {
      const result = markdownTableBackwardCell(buffer)
      editor.message(result.message)
      return
    }
    cycleGlobalVisibility(editor, buffer)
  }, "Global heading visibility cycle (like S-TAB in markdown-mode).")

  editor.command("markdown-toggle-markup-hiding", ({ editor, buffer, prefixArgument }) => {
    const enabled = toggleBufferBoolean(buffer, () => markdownHideMarkup(buffer), setMarkdownHideMarkup, prefixArgument)
    editor.message(`markdown-mode markup hiding ${enabled ? "enabled" : "disabled"}`)
  }, "Toggle display of markup delimiters (`markdown-hide-markup`).")

  editor.command("markdown-toggle-url-hiding", ({ editor, buffer, prefixArgument }) => {
    const enabled = toggleBufferBoolean(buffer, () => markdownHideUrls(buffer), setMarkdownHideUrls, prefixArgument)
    editor.message(`markdown-mode URL hiding ${enabled ? "enabled" : "disabled"}`)
  }, "Toggle URL hiding in links (`markdown-hide-urls`).")

  editor.command("markdown-toggle-fontify-code-blocks-natively", ({ editor, buffer, prefixArgument }) => {
    const enabled = toggleBufferBoolean(
      buffer,
      () => markdownFontifyCodeBlocksNatively(buffer),
      setMarkdownFontifyCodeBlocksNatively,
      prefixArgument,
    )
    editor.message(`markdown-mode native code block fontification ${enabled ? "enabled" : "disabled"}`)
    editor.changed("markdown-toggle-fontify-code-blocks-natively")
  }, "Toggle native fontification of fenced code blocks (`markdown-fontify-code-blocks-natively`).")

  editor.command("markdown-view-mode", ({ editor, buffer }) => {
    editor.enterMode(buffer, "markdown-view-mode")
  }, "Enter read-oriented Markdown view mode with markup hiding.")

  editor.command("gfm-view-mode", ({ editor, buffer }) => {
    editor.enterMode(buffer, "gfm-view-mode")
  }, "Enter read-oriented GFM view mode with markup hiding.")

  editor.command("markdown-export", async ({ editor, buffer }) => {
    try {
      const outputPath = await markdownExportBuffer(buffer, deps)
      editor.message(`Wrote ${outputPath}`)
    } catch (error) {
      editor.message((error as Error).message)
    }
  }, "Export the current Markdown buffer to an HTML file.")

  editor.command("markdown-preview", async ({ editor, buffer }) => {
    try {
      const outputPath = await markdownExportBuffer(buffer, deps, markdownPreviewPath(buffer, deps))
      markdownOpenExternal(pathToFileURL(outputPath).href, deps, true)
      editor.message(`Previewing ${outputPath}`)
    } catch (error) {
      editor.message((error as Error).message)
    }
  }, "Export the current Markdown buffer to a temporary HTML file and open it.")

  editor.command("markdown-toggle-inline-images", ({ editor, prefixArgument }) => {
    const current = getCustom<boolean>("markdown-display-inline-images") ?? true
    const next = prefixArgument == null ? !current : prefixArgument > 0
    setCustom("markdown-display-inline-images", next)
    editor.message(`markdown-mode inline images ${next ? "enabled" : "disabled"}`)
    void editor.changed("markdown-toggle-inline-images")
  }, "Toggle inline image display (`markdown-display-inline-images`).")

  editor.command("markdown-live-preview-mode", async ({ editor, buffer, prefixArgument }) => {
    const current = buffer.locals.get(LIVE_PREVIEW_LOCAL) === true
    const next = prefixArgument == null ? !current : prefixArgument > 0
    buffer.locals.set(LIVE_PREVIEW_LOCAL, next)
    if (next) {
      try {
        const outputPath = await markdownExportBuffer(buffer, deps, markdownPreviewPath(buffer, deps))
        buffer.locals.set(LIVE_PREVIEW_PATH_LOCAL, outputPath)
        markdownOpenExternal(pathToFileURL(outputPath).href, deps, true)
      } catch (error) {
        editor.message((error as Error).message)
        return
      }
    }
    editor.message(`markdown-live-preview-mode ${next ? "enabled" : "disabled"}`)
  }, "Re-export the buffer to its HTML preview on every save while enabled.")

  editor.command("markdown-open", ({ editor, buffer }) => {
    if (!buffer.path) {
      editor.message("Buffer is not visiting a file")
      return
    }
    const command = getCustom<string>("markdown-open-command") ?? ""
    if (!command.trim()) {
      editor.message("markdown-open-command is empty")
      return
    }
    try {
      const spawn = deps.spawn ?? spawnProcess
      spawn({ cmd: ["sh", "-c", `${command} "$1"`, "markdown-open", buffer.path], cwd: buffer.directory() })
      editor.message(`Opened ${buffer.path}`)
    } catch (error) {
      editor.message((error as Error).message)
    }
  }, "Run `markdown-open-command` on the current buffer file.")

  editor.command("markdown-check-refs", ({ editor, buffer }) => {
    const labels = markdownUndefinedReferenceLabels(buffer.text)
    if (!labels.length) {
      editor.message("No undefined reference labels")
      return
    }
    const text = labels.map(label => `Undefined reference: [${label}]`).join("\n") + "\n"
    editor.scratch("*Markdown Reference Check*", text, "text")
    editor.message(`${labels.length} undefined reference label${labels.length === 1 ? "" : "s"}`)
  }, "List undefined Markdown reference-link labels.")

  editor.command("markdown-toc-generate-toc", ({ editor, buffer }) => {
    buffer.insert(markdownTocText(buffer.text))
    editor.message("Inserted markdown TOC")
  }, "Insert a markdown-toc table of contents at point.")

  editor.command("markdown-toc-refresh-toc", ({ editor, buffer }) => {
    const range = markdownTocBlockRange(buffer.text)
    if (!range) {
      editor.message("No markdown TOC found")
      return
    }
    buffer.replaceRange(range.start, range.end, markdownTocText(buffer.text))
    buffer.point = range.start
    editor.message("Refreshed markdown TOC")
  }, "Refresh an existing markdown-toc table of contents.")

  editor.command("markdown-narrow-to-subtree", ({ editor }) => {
    editor.message("Narrowing is not supported")
  }, "Narrow to the current Markdown subtree.")

  editor.command("markdown-outdent-or-delete", ({ buffer }) => {
    if (buffer.deleteActiveRegion()) return
    const line = buffer.lineBoundsAt()
    const content = line.text.replace(/^\s*/, "")
    if (content.length === 0 && line.text.length > 0) {
      markdownOutdentLine(buffer)
      return
    }
    if (buffer.point > 0) buffer.deleteBackward()
  }, "Outdent when only whitespace precedes point, else delete backward.")

  editor.command("markdown-indent-region", ({ buffer }) => {
    const region = regionBounds(buffer)
    indentRegion(buffer, region.start, region.end, TAB_WIDTH)
  }, "Indent the active region.")

  editor.command("markdown-outdent-region", ({ buffer }) => {
    const region = regionBounds(buffer)
    indentRegion(buffer, region.start, region.end, -TAB_WIDTH)
  }, "Outdent the active region.")

  editor.command("markdown-insert-link", async ({ buffer, editor }) => {
    const url = await editor.prompt("URL or [reference]: ", "", "markdown-url")
    if (!url) return
    const region = activeRegion(buffer)
    if (region) {
      const text = buffer.text.slice(region.start, region.end)
      insertMarkdownLink(buffer, region.start, region.end, text, url)
      buffer.clearMark()
      editor.message("Inserted link")
      return
    }
    const text = await editor.prompt("Link text: ", "", "markdown-link-text")
    if (text == null) return
    insertMarkdownLink(buffer, buffer.point, buffer.point, text || url, url)
    editor.message("Inserted link")
  }, "Insert a Markdown inline link.")

  editor.command("markdown-insert-footnote", ({ buffer, editor }) => {
    const label = nextFootnoteNumber(buffer.text)
    const marker = `[^${label}]`
    const markerStart = buffer.point
    buffer.insert(marker)
    const defPoint = appendFootnoteDefinition(buffer, label)
    buffer.locals.set(MARKDOWN_FOOTNOTE_RETURN_POINT, markerStart)
    buffer.point = defPoint
    editor.message("Inserted footnote")
  }, "Insert a Markdown footnote marker and definition.")

  editor.command("markdown-footnote-goto-text", ({ buffer, editor }) => {
    const footnote = footnoteMarkerAtPoint(buffer.text, buffer.point)
    if (!footnote) { editor.message("No footnote at point"); return }
    const def = findFootnoteDefinition(buffer.text, footnote.label)
    if (!def) { editor.message("No footnote definition"); return }
    buffer.locals.set(MARKDOWN_FOOTNOTE_RETURN_POINT, footnote.start)
    buffer.point = def.textStart
  }, "Jump from a Markdown footnote marker to its definition text.")

  editor.command("markdown-footnote-return", ({ buffer, editor }) => {
    const def = footnoteDefinitionAtPoint(buffer.text, buffer.point)
    if (def) {
      const marker = findFootnoteMarker(buffer.text, def.label)
      if (!marker) { editor.message("No footnote marker"); return }
      buffer.point = marker.start
      return
    }
    const saved = buffer.locals.get(MARKDOWN_FOOTNOTE_RETURN_POINT)
    if (typeof saved === "number") {
      buffer.point = Math.max(0, Math.min(saved, buffer.text.length))
      return
    }
    editor.message("No footnote return point")
  }, "Return from a Markdown footnote definition to its marker.")

  editor.command("markdown-insert-reference-link-dwim", async ({ buffer, editor }) => {
    const text = await editor.prompt("Link text: ", "", "markdown-link-text")
    if (text == null) return
    const label = await editor.prompt("Label: ", text, "markdown-reference-label")
    if (label == null) return
    const url = await editor.prompt("URL: ", "", "markdown-url")
    if (!url) return
    insertMarkdownReferenceLink(buffer, text, label || text, url)
    editor.message("Inserted reference link")
  }, "Insert a Markdown reference link and definition.")

  editor.command("markdown-table-align", ({ buffer, editor }) => {
    const result = markdownTableAlign(buffer)
    editor.message(result.message)
  }, "Align the pipe table at point.")

  editor.command("markdown-table-forward-cell", ({ buffer, editor }) => {
    const result = markdownTableForwardCell(buffer)
    editor.message(result.message)
  }, "Move forward one Markdown table cell, inserting a row at end.")

  editor.command("markdown-table-backward-cell", ({ buffer, editor }) => {
    const result = markdownTableBackwardCell(buffer)
    editor.message(result.message)
  }, "Move backward one Markdown table cell.")

  editor.command("markdown-insert-table", async ({ buffer, editor }) => {
    const rowsRaw = await editor.prompt("Rows: ", "2", "markdown-table-rows")
    if (rowsRaw == null) return
    const colsRaw = await editor.prompt("Columns: ", "2", "markdown-table-columns")
    if (colsRaw == null) return
    const rows = Number.parseInt(rowsRaw, 10)
    const columns = Number.parseInt(colsRaw, 10)
    if (!Number.isFinite(rows) || !Number.isFinite(columns) || rows < 1 || columns < 1) {
      editor.message("Invalid table size")
      return
    }
    const result = markdownInsertTable(buffer, rows, columns)
    editor.message(result.message)
  }, "Insert a GFM pipe table.")

  editor.command("markdown-table-insert-row", ({ buffer, editor }) => {
    const result = markdownTableInsertRow(buffer)
    editor.message(result.message)
  }, "Insert a table row above the current row.")

  editor.command("markdown-table-delete-row", ({ buffer, editor }) => {
    const result = markdownTableDeleteRow(buffer)
    editor.message(result.message)
  }, "Delete the current table row.")

  editor.command("markdown-table-insert-column", ({ buffer, editor }) => {
    const result = markdownTableInsertColumn(buffer)
    editor.message(result.message)
  }, "Insert a table column to the left.")

  editor.command("markdown-table-delete-column", ({ buffer, editor }) => {
    const result = markdownTableDeleteColumn(buffer)
    editor.message(result.message)
  }, "Delete the current table column.")

  editor.command("markdown-table-move-row-up", ({ buffer, editor }) => {
    const result = markdownTableMoveRow(buffer, -1)
    editor.message(result.message)
  }, "Move the current table row up.")

  editor.command("markdown-table-move-row-down", ({ buffer, editor }) => {
    const result = markdownTableMoveRow(buffer, 1)
    editor.message(result.message)
  }, "Move the current table row down.")

  editor.command("markdown-table-move-column-left", ({ buffer, editor }) => {
    const result = markdownTableMoveColumn(buffer, -1)
    editor.message(result.message)
  }, "Move the current table column left.")

  editor.command("markdown-table-move-column-right", ({ buffer, editor }) => {
    const result = markdownTableMoveColumn(buffer, 1)
    editor.message(result.message)
  }, "Move the current table column right.")

  editor.command("markdown-insert-bold", ({ buffer, editor }) => {
    wrapOrInsert(buffer, "**", "**", "text")
    editor.message("Inserted bold")
  }, "Insert bold markup.")

  editor.command("markdown-insert-italic", ({ buffer, editor }) => {
    wrapOrInsert(buffer, "*", "*", "text")
    editor.message("Inserted italic")
  }, "Insert italic markup.")

  editor.command("markdown-insert-code", ({ buffer, editor }) => {
    wrapOrInsert(buffer, "`", "`", "code")
    editor.message("Inserted inline code")
  }, "Insert inline code markup.")

  editor.command("markdown-insert-gfm-code-block", async ({ buffer, editor, args }) => {
    const language = await readGfmCodeBlockLanguage(editor, buffer, args)
    if (language == null) return
    insertGfmCodeBlock(buffer, language)
    editor.message("Inserted GFM code block")
  }, "Insert a fenced GFM code block.")

  editor.command("markdown-edit-code-block", ({ buffer, editor }) => {
    if (buffer.locals.has(EDIT_INDIRECT_KEY)) {
      finishEditIndirect(editor, buffer, true)
      return
    }
    const block = markdownCodeBlockAtPoint(buffer.text, buffer.point)
    if (!block) {
      editor.message("No code block at point")
      return
    }
    const body = buffer.text.slice(block.bodyStart, block.bodyEnd)
    const mode = markdownGetLangMode(block.lang) ?? "text"
    const edit = new BufferModel({ name: `*edit code block: ${block.lang ?? "code"}*`, text: body, kind: "scratch", mode })
    editor.addBuffer(edit)
    editor.enterMode(edit, mode)
    attachEditIndirect(edit, buffer, block.bodyStart, block.bodyEnd)
    editor.displayBufferInOtherWindow(edit.id, { select: true })
    editor.message("Edit, then C-c ' or C-c C-c to commit, C-c C-k to abort")
  }, "Edit the fenced code block at point in a language-mode buffer (commit from the edit buffer).")

  editor.command("edit-indirect-commit", ({ buffer, editor }) => {
    finishEditIndirect(editor, buffer, true)
  }, "Commit the edit-indirect buffer back to its source code block.")

  editor.command("edit-indirect-abort", ({ buffer, editor }) => {
    finishEditIndirect(editor, buffer, false)
  }, "Abort the edit-indirect buffer, discarding changes.")

  editor.command("markdown-insert-blockquote", ({ buffer, editor }) => {
    const line = buffer.lineBoundsAt()
    const content = line.text.replace(/^\s*/, "")
    buffer.replaceRange(line.start, line.end, `> ${content}`)
    editor.message("Inserted blockquote")
  }, "Prefix the current line with a blockquote marker.")

  editor.command("markdown-insert-list-item", ({ buffer, editor, prefixArgument }) => {
    insertMarkdownListItem(buffer, prefixArgument)
    editor.message("Inserted list item")
  }, "Start a new list item on the next line.")

  editor.command("markdown-insert-gfm-checkbox", ({ buffer, editor }) => {
    const result = insertMarkdownCheckbox(buffer)
    editor.message(result.message)
  }, "Insert a GFM task list checkbox.")

  editor.command("markdown-toggle-gfm-checkbox", ({ buffer, editor }) => {
    const result = markdownToggleCheckbox(buffer, buffer.point)
    editor.message(result.message)
  }, "Toggle the GFM task list checkbox at point.")

  editor.command("markdown-cleanup-list-numbers", ({ buffer, editor }) => {
    const result = markdownCleanupListNumbers(buffer)
    editor.message(result.message)
  }, "Renumber ordered Markdown lists in the buffer.")

  editor.command("markdown-insert-hr", ({ buffer, editor }) => {
    const line = buffer.lineBoundsAt()
    const hr = `${"-".repeat(5)}\n`
    if (line.text.trim()) buffer.insert(`\n${hr}`)
    else buffer.replaceRange(line.start, line.end, hr)
    editor.message("Inserted horizontal rule")
  }, "Insert a horizontal rule.")

  for (let level = 1; level <= 6; level++) {
    const name = `markdown-insert-header-atx-${level}`
    editor.command(name, ({ buffer, editor }) => {
      insertAtxHeader(buffer, level)
      editor.message(`Inserted ATX header level ${level}`)
    }, `Insert a level-${level} ATX header.`)
  }

  editor.command("markdown-insert-header-setext-1", ({ buffer, editor }) => {
    insertSetextHeader(buffer, 1)
    editor.message("Inserted setext level-1 header")
  }, "Insert a level-1 setext header.")

  editor.command("markdown-insert-header-setext-2", ({ buffer, editor }) => {
    insertSetextHeader(buffer, 2)
    editor.message("Inserted setext level-2 header")
  }, "Insert a level-2 setext header.")

  editor.command("markdown-insert-header-dwim", ({ buffer, editor }) => {
    const line = buffer.lineBoundsAt()
    if (/^#{1,6}\s/.test(line.text.trim())) changeHeaderLevel(buffer, 1)
    else insertAtxHeader(buffer, 1)
    editor.message("Inserted or demoted header")
  }, "Insert or demote an ATX header at point.")

  editor.command("markdown-promote", ({ buffer, editor }) => {
    const result = markdownInTable(buffer) ? markdownTableMoveColumn(buffer, -1) : markdownPromoteOrDemote(buffer, -1)
    editor.message(result.message)
  }, "Promote the heading or list item at point.")

  editor.command("markdown-demote", ({ buffer, editor }) => {
    const result = markdownInTable(buffer) ? markdownTableMoveColumn(buffer, 1) : markdownPromoteOrDemote(buffer, 1)
    editor.message(result.message)
  }, "Demote the heading or list item at point.")

  editor.command("markdown-promote-list-item", ({ buffer, editor }) => {
    const result = markdownPromoteOrDemoteListItem(buffer, -1)
    editor.message(result.message)
  }, "Promote the Markdown list item at point.")

  editor.command("markdown-demote-list-item", ({ buffer, editor }) => {
    const result = markdownPromoteOrDemoteListItem(buffer, 1)
    editor.message(result.message)
  }, "Demote the Markdown list item at point.")

  editor.command("markdown-promote-subtree", ({ buffer, editor }) => {
    const result = markdownPromoteOrDemoteSubtree(buffer, -1)
    editor.message(result.message)
  }, "Promote the current heading subtree.")

  editor.command("markdown-demote-subtree", ({ buffer, editor }) => {
    const result = markdownPromoteOrDemoteSubtree(buffer, 1)
    editor.message(result.message)
  }, "Demote the current heading subtree.")

  editor.command("markdown-move-subtree-up", ({ buffer, editor }) => {
    const result = markdownMoveSubtree(buffer, -1)
    editor.message(result.message)
  }, "Move the current heading subtree before its previous sibling.")

  editor.command("markdown-move-subtree-down", ({ buffer, editor }) => {
    const result = markdownMoveSubtree(buffer, 1)
    editor.message(result.message)
  }, "Move the current heading subtree after its next sibling.")

  editor.command("markdown-move-list-item-up", ({ buffer, editor }) => {
    const result = markdownMoveListItem(buffer, -1)
    editor.message(result.message)
  }, "Move the current Markdown list item before its previous sibling.")

  editor.command("markdown-move-list-item-down", ({ buffer, editor }) => {
    const result = markdownMoveListItem(buffer, 1)
    editor.message(result.message)
  }, "Move the current Markdown list item after its next sibling.")

  editor.command("markdown-move-up", ({ buffer, editor }) => {
    const heading = markdownHeadingAtPointIncludingSetextUnderline(buffer.text, buffer.point)
    const result = markdownInTable(buffer) ? markdownTableMoveRow(buffer, -1) : heading ? markdownMoveSubtree(buffer, -1) : markdownMoveListItem(buffer, -1)
    editor.message(result.message)
  }, "Move the current heading subtree or list item up.")

  editor.command("markdown-move-down", ({ buffer, editor }) => {
    const heading = markdownHeadingAtPointIncludingSetextUnderline(buffer.text, buffer.point)
    const result = markdownInTable(buffer) ? markdownTableMoveRow(buffer, 1) : heading ? markdownMoveSubtree(buffer, 1) : markdownMoveListItem(buffer, 1)
    editor.message(result.message)
  }, "Move the current heading subtree or list item down.")

  editor.command("markdown-insert-strike-through", ({ buffer, editor }) => {
    wrapOrInsert(buffer, "~~", "~~", "text")
    editor.message("Inserted strike-through")
  }, "Insert GFM strike-through markup.")

  editor.command("markdown-kill-thing-at-point", ({ buffer, editor }) => {
    const line = buffer.lineBoundsAt()
    const match = line.text.match(/^(\s*)(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/)
    if (match) {
      const end = line.start + (match[0]?.length ?? 0)
      buffer.deleteRange(line.start, end)
      editor.message("Killed markup")
      return
    }
    editor.message("Nothing to kill at point")
  }, "Kill markup prefix at beginning of line.")

  editor.command("markdown-follow-thing-at-point", ({ buffer, editor }) => {
    const link = linkAtPoint(buffer.text, buffer.point, markdownIsGfmMode(buffer))
    if (!link) { editor.message("No link at point"); return }
    if (link.kind === "reference") {
      if (link.definitionStart == null) { editor.message("No reference definition"); return }
      buffer.point = link.definitionStart
      editor.message(`Followed [${link.label}]`)
      return
    }
    const url = link.url
    if (!url) { editor.message("No link at point"); return }
    markdownOpenExternal(url, deps)
    editor.message(`Followed ${url}`)
  }, "Follow link at point.")

  editor.command("markdown-do", ({ buffer, editor }) => {
    const checkbox = markdownToggleCheckbox(buffer, buffer.point)
    if (checkbox.changed) {
      editor.message(checkbox.message)
      return
    }
    if (markdownInTable(buffer)) {
      const result = markdownTableAlign(buffer)
      editor.message(result.message)
      return
    }
    const link = linkAtPoint(buffer.text, buffer.point, markdownIsGfmMode(buffer))
    if (link) {
      if (link.kind === "reference") {
        if (link.definitionStart == null) { editor.message("No reference definition"); return }
        buffer.point = link.definitionStart
        editor.message(`Followed [${link.label}]`)
        return
      }
      if (!link.url) { editor.message("No link at point"); return }
      markdownOpenExternal(link.url, deps)
      editor.message(`Followed ${link.url}`)
      return
    }
    editor.message("Nothing to do at point")
  }, "Do what is sensible at point in Markdown.")

  editor.command("markdown-next-link", ({ buffer, editor }) => {
    const next = findLink(buffer.text, buffer.point, 1, markdownIsGfmMode(buffer))
    if (next == null) { editor.message("No next link"); return }
    buffer.point = next
  }, "Move to next Markdown link.")

  editor.command("markdown-previous-link", ({ buffer, editor }) => {
    const prev = findLink(buffer.text, buffer.point, -1, markdownIsGfmMode(buffer))
    if (prev == null) { editor.message("No previous link"); return }
    buffer.point = prev
  }, "Move to previous Markdown link.")

  editor.command("markdown-beginning-of-line", ({ buffer }) => {
    const line = buffer.lineBoundsAt()
    const text = line.text
    const contentStart = text.match(/^\s*/)?.[0].length ?? 0
    const marker = text.slice(contentStart).match(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/)?.[0].length ?? 0
    const target = line.start + contentStart + marker
    buffer.point = buffer.point <= target ? line.start : target
  }, "Move to meaningful beginning of line in Markdown context.")

  editor.command("markdown-end-of-line", ({ buffer }) => {
    const line = buffer.lineBoundsAt()
    buffer.point = line.end
  }, "Move to end of line.")

  editor.command("markdown-forward-paragraph", ({ buffer }) => {
    buffer.point = findParagraphBoundary(buffer.text, buffer.point, 1)
  }, "Move forward to the next paragraph boundary.")

  editor.command("markdown-backward-paragraph", ({ buffer }) => {
    buffer.point = findParagraphBoundary(buffer.text, buffer.point, -1)
  }, "Move backward to the previous paragraph boundary.")

  editor.command("markdown-outline-next", ({ buffer }) => {
    buffer.point = findHeading(buffer.text, buffer.point, 1, false)
  }, "Move to the next heading.")

  editor.command("markdown-outline-previous", ({ buffer }) => {
    buffer.point = findHeading(buffer.text, buffer.point, -1, false)
  }, "Move to the previous heading.")

  editor.command("markdown-outline-next-same-level", ({ buffer }) => {
    const level = headingLevelAt(buffer.text, buffer.point)
    buffer.point = findHeading(buffer.text, buffer.point, 1, true, level)
  }, "Move to the next heading at the same level.")

  editor.command("markdown-outline-previous-same-level", ({ buffer }) => {
    const level = headingLevelAt(buffer.text, buffer.point)
    buffer.point = findHeading(buffer.text, buffer.point, -1, true, level)
  }, "Move to the previous heading at the same level.")

  editor.command("markdown-outline-up", ({ buffer }) => {
    const level = headingLevelAt(buffer.text, buffer.point)
    if (level <= 1) return
    buffer.point = findHeading(buffer.text, buffer.point, -1, true, level - 1)
  }, "Move to the parent heading.")

  editor.command("markdown-mode", ({ editor, buffer }) => editor.enterMode(buffer, "markdown"),
    "Major mode for editing Markdown files.")

  editor.command("gfm-mode", ({ editor, buffer }) => editor.enterMode(buffer, "gfm"),
    "Major mode for editing GitHub Flavored Markdown files.")
}

function isPluginContext(value: MarkdownDeps | PluginContext | undefined): value is PluginContext {
  return typeof value === "object" && value !== null && "advice" in value && "command" in value
}

export function install(editor: Editor, ctx: PluginContext): void
export function install(editor: Editor, deps?: MarkdownDeps, ctx?: PluginContext): void
export function install(editor: Editor, depsOrCtx: MarkdownDeps | PluginContext = {}, maybeCtx?: PluginContext): void {
  const deps = isPluginContext(depsOrCtx) ? {} : depsOrCtx
  const ctx = isPluginContext(depsOrCtx) ? depsOrCtx : maybeCtx ?? createPluginContext(editor)
  registerTreeSitterGrammars()
  installMarkdownCommands(editor, deps)
  // Global so C-c ' also commits from the edit buffer, whose major mode is
  // the block's language and has no markdown keymap.
  editor.key("C-c '", "markdown-edit-code-block")

  if (gfmBackquoteAdviceId === undefined || getTrackedAdvice(gfmBackquoteAdviceId) === undefined) {
    gfmBackquoteAdviceId = ctx.advice("self-insert-command", {
      after: ({ editor, buffer, args, keyEvent }) => maybeInsertElectricGfmCodeBlock(editor, buffer, args, keyEvent),
    })
    ctx.onDispose(() => { gfmBackquoteAdviceId = undefined })
  }

  for (const [name] of MARKDOWN_HEADER_FACES) defface(name, {}, "Markdown ATX/setext header face.")
  defface("markdown-emphasis", { italic: true }, "Markdown italic emphasis.")
  defface("markdown-strong", { bold: true }, "Markdown bold emphasis.")
  defface("markdown-link", { underline: true }, "Markdown link face.")
  defface("markdown-markup", { inherit: ["keyword"] }, "Markdown markup delimiter face.")
  defface("markdown-strikethrough", { underline: true }, "GFM strikethrough text face.")
  const keymap = new Keymap("markdown-map")
  bindMarkdownModeMap(keymap)

  defineMode({
    name: "markdown",
    parent: "text",
    commentStart: "<!--",
    keymap,
    indentLine: markdownIndentLine,
    fontLock: markdownFontLock,
    displayFilter: markdownDisplayFilter,
    mouseClick: markdownToggleCheckboxAtPoint,
    onEnter: applyMarkdownFaceRemap,
  })

  const gfmKeymap = new Keymap("gfm-map")
  gfmKeymap.bind("C-c C-s d", "markdown-insert-strike-through")
  gfmKeymap.bind("C-c C-s C", "markdown-insert-gfm-code-block")
  defineMode({
    name: "gfm",
    parent: "markdown",
    keymap: gfmKeymap,
    fontLock: markdownFontLock,
    onEnter: applyGfmFaceRemap,
  })

  defineMode({
    name: "markdown-view-mode",
    parent: "markdown",
    onEnter: applyMarkdownViewModeEnter,
  })

  defineMode({
    name: "gfm-view-mode",
    parent: "gfm",
    onEnter: applyGfmViewModeEnter,
  })

  addHook("after-save-hook", async ({ buffer }) => {
    if (buffer.locals.get(LIVE_PREVIEW_LOCAL) !== true) return
    const target = buffer.locals.get(LIVE_PREVIEW_PATH_LOCAL) as string | undefined
    try {
      await markdownExportBuffer(buffer, deps, target ?? markdownPreviewPath(buffer, deps))
    } catch { /* preview refresh is best-effort; the export command reports errors */ }
  })

  addHook("find-file-hook", ({ buffer }) => {
    if (!buffer.path) return
    const mode = /\.md$/i.test(buffer.path) && /README\.md$/i.test(buffer.path) ? "gfm"
      : /\.(?:md|markdown|mkd|mdown|mkdn|mdwn)$/i.test(buffer.path) ? "markdown"
      : null
    if (mode) enterMode(buffer, mode)
  })
}

function wrapOrInsert(buffer: BufferModel, open: string, close: string, placeholder: string): void {
  const region = activeRegion(buffer)
  if (region) {
    const text = buffer.text.slice(region.start, region.end)
    buffer.replaceRange(region.start, region.end, `${open}${text}${close}`)
    buffer.point = region.end + open.length + close.length
    buffer.clearMark()
    return
  }
  buffer.insert(`${open}${placeholder}${close}`)
  buffer.point -= close.length + placeholder.length
}

function insertMarkdownLink(buffer: BufferModel, start: number, end: number, text: string, url: string): void {
  const link = `[${text}](${url})`
  buffer.replaceRange(start, end, link)
  buffer.point = start + link.length
}

function insertMarkdownReferenceLink(buffer: BufferModel, text: string, label: string, url: string): void {
  const insertPoint = buffer.point
  const link = `[${text}][${label}]`
  buffer.replaceRange(insertPoint, insertPoint, link)
  buffer.point = insertPoint + link.length
  if (findReferenceDefinition(buffer.text, label)) return

  const def = `[${label}]: ${url}`
  const paragraphEnd = findCurrentParagraphEnd(buffer.text, insertPoint)
  const insertion = paragraphEnd >= buffer.text.length
    ? `${appendBlockSeparator(buffer.text)}${def}`
    : `\n\n${def}`
  buffer.replaceRange(paragraphEnd, paragraphEnd, insertion)
  buffer.point = insertPoint + link.length
}

function appendFootnoteDefinition(buffer: BufferModel, label: string): number {
  const insertion = `${appendBlockSeparator(buffer.text)}[^${label}]: `
  const at = buffer.text.length
  buffer.replaceRange(at, at, insertion)
  return at + insertion.length
}

function appendBlockSeparator(text: string): string {
  if (!text) return ""
  if (text.endsWith("\n\n")) return ""
  if (text.endsWith("\n")) return "\n"
  return "\n\n"
}

function markdownListPrefix(lineText: string): { indent: string; marker: string; orderedLine: number | null } | null {
  const checkbox = /^(\s*)([-*+]|\d+[.)])(\s+)\[[ xX]\]\s*/.exec(lineText)
  if (checkbox) {
    return { indent: checkbox[1] ?? "", marker: `${checkbox[2]}${checkbox[3]}[ ] `, orderedLine: null }
  }
  const ordered = /^(\s*)(\d+)([.)])(\s+)/.exec(lineText)
  if (ordered) {
    return {
      indent: ordered[1] ?? "",
      marker: `${Number(ordered[2]) + 1}${ordered[3]}${ordered[4]}`,
      orderedLine: Number(ordered[2]) + 1,
    }
  }
  const unordered = /^(\s*)([-*+])(\s+)/.exec(lineText)
  if (unordered) return { indent: unordered[1] ?? "", marker: `${unordered[2]}${unordered[3]}`, orderedLine: null }
  return null
}

function markdownAdjustedIndent(indent: string, prefixArgument: number | null | undefined): string {
  if (prefixArgument === 4) return indent.slice(0, Math.max(0, indent.length - TAB_WIDTH))
  if (prefixArgument === 16) return `${indent}${" ".repeat(TAB_WIDTH)}`
  return indent
}

function markdownEmptyListItem(lineText: string): boolean {
  const match = lineText.match(/^(\s*)([-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.*)$/)
  return !!match && (match[3] ?? "").trim() === ""
}

function markdownNonEmptyListItem(lineText: string): boolean {
  const match = lineText.match(/^(\s*)([-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.*)$/)
  return !!match && (match[3] ?? "").trim() !== ""
}

function insertMarkdownListItem(buffer: BufferModel, prefixArgument?: number | null): void {
  const line = buffer.lineBoundsAt()
  const current = markdownListPrefix(line.text)
  const fallbackIndent = line.text.match(/^\s*/)?.[0] ?? ""
  const indent = markdownAdjustedIndent(current?.indent ?? fallbackIndent, prefixArgument)
  const marker = current?.marker ?? "- "
  const insertPoint = line.text.trim() ? line.end : buffer.point
  const insertion = line.text.trim() ? `\n${indent}${marker}` : `${indent}${marker}`
  buffer.replaceRange(insertPoint, insertPoint, insertion)
  buffer.point = insertPoint + insertion.length
  if (current?.orderedLine != null) {
    const insertedLine = buffer.text.slice(0, insertPoint).split("\n").length - (line.text.trim() ? 0 : 1)
    renumberOrderedListContainingLine(buffer, insertedLine, indent.length)
  }
}

function insertMarkdownCheckbox(buffer: BufferModel): MarkdownEditResult {
  const line = buffer.lineBoundsAt()
  const checkboxList = /^(\s*)(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/.exec(line.text)
  if (checkboxList) {
    buffer.insert(`\n${checkboxList[1]}- [ ] `)
    return { changed: true, message: "Inserted checkbox" }
  }

  const list = line.text.match(LIST_RE)
  if (list && line.text.slice(list[0]!.length).trim()) {
    const markerEnd = line.start + list[0]!.length
    buffer.replaceRange(markerEnd, markerEnd, "[ ] ")
    buffer.point = markerEnd + "[ ] ".length
    return { changed: true, message: "Inserted checkbox" }
  }
  if (list) {
    buffer.insert(`\n${list[1]}- [ ] `)
    return { changed: true, message: "Inserted checkbox" }
  }

  const indent = line.text.match(/^\s*/)?.[0] ?? ""
  const content = line.text.slice(indent.length)
  if (content.trim()) {
    const replacement = `${indent}- [ ] ${content}`
    buffer.replaceRange(line.start, line.end, replacement)
    buffer.point = line.start + `${indent}- [ ] `.length
    return { changed: true, message: "Inserted checkbox" }
  }

  buffer.replaceRange(line.start, line.end, `${indent}- [ ] `)
  buffer.point = line.start + `${indent}- [ ] `.length
  return { changed: true, message: "Inserted checkbox" }
}

function markdownCleanupListNumbers(buffer: BufferModel): MarkdownEditResult {
  const lines = buffer.text.split("\n")
  const counters = new Map<number, number>()
  const activeIndents = new Set<number>()
  let changed = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const list = line.match(LIST_RE)
    if (list) {
      const indent = list[1]!.length
      for (const active of [...activeIndents]) {
        if (active > indent) activeIndents.delete(active)
      }
      activeIndents.add(indent)
      for (const key of [...counters.keys()]) {
        if (key > indent) counters.delete(key)
      }

      const ordered = line.match(ORDERED_LIST_RE)
      if (!ordered) {
        counters.delete(indent)
        continue
      }

      const next = (counters.get(indent) ?? 0) + 1
      counters.set(indent, next)
      if (Number(ordered[2]) !== next) {
        lines[i] = `${ordered[1]}${next}${ordered[3]}${line.slice(ordered[0]!.length - 1)}`
        changed = true
      }
      continue
    }

    if (!line.trim()) {
      counters.clear()
      activeIndents.clear()
      continue
    }

    const indent = line.match(/^\s*/)?.[0].length ?? 0
    if (![...activeIndents].some(active => indent > active)) {
      counters.clear()
      activeIndents.clear()
    }
  }

  if (!changed) return { changed: false, message: "List numbers already clean" }
  const point = buffer.point
  buffer.replaceRange(0, buffer.text.length, lines.join("\n"))
  buffer.point = Math.min(point, buffer.text.length)
  return { changed: true, message: "Cleaned up list numbers" }
}

function renumberOrderedListContainingLine(buffer: BufferModel, lineNumber: number, targetIndent: number): void {
  const lines = buffer.text.split("\n")
  if (!lines[lineNumber]?.match(ORDERED_LIST_RE)) return

  let start = lineNumber
  for (let i = lineNumber - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.trim()) break
    const list = line.match(LIST_RE)
    const indent = list?.[1]?.length
    if (list && indent != null && indent < targetIndent) break
    if (list && indent === targetIndent && !ORDERED_LIST_RE.test(line)) break
    if (!list && (line.match(/^\s*/)?.[0].length ?? 0) <= targetIndent) break
    start = i
  }

  let end = lineNumber
  for (let i = lineNumber + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim()) break
    const list = line.match(LIST_RE)
    const indent = list?.[1]?.length
    if (list && indent != null && indent < targetIndent) break
    if (list && indent === targetIndent && !ORDERED_LIST_RE.test(line)) break
    if (!list && (line.match(/^\s*/)?.[0].length ?? 0) <= targetIndent) break
    end = i
  }

  const first = lines.slice(start, end + 1)
    .map(line => line.match(ORDERED_LIST_RE))
    .find(match => match && match[1]!.length === targetIndent)
  if (!first) return

  let next = Number(first[2])
  let changed = false
  for (let i = start; i <= end; i++) {
    const ordered = lines[i]!.match(ORDERED_LIST_RE)
    if (!ordered || ordered[1]!.length !== targetIndent) continue
    if (Number(ordered[2]) !== next) {
      lines[i] = `${ordered[1]}${next}${ordered[3]}${lines[i]!.slice(ordered[0]!.length - 1)}`
      changed = true
    }
    next++
  }
  if (!changed) return

  const point = buffer.point
  buffer.replaceRange(0, buffer.text.length, lines.join("\n"))
  buffer.point = Math.min(point, buffer.text.length)
}

function insertAtxHeader(buffer: BufferModel, level: number): void {
  const hashes = "#".repeat(level) + " "
  const region = activeRegion(buffer)
  if (region) {
    const text = buffer.text.slice(region.start, region.end).replace(/^#+\s*/, "")
    buffer.replaceRange(region.start, region.end, `${hashes}${text}`)
    return
  }
  const line = buffer.lineBoundsAt()
  const trimmed = line.text.trimStart()
  if (trimmed) buffer.replaceRange(line.start, line.end, `${hashes}${trimmed}`)
  else buffer.insert(`${hashes}Heading ${level}`)
}

function insertSetextHeader(buffer: BufferModel, level: 1 | 2): void {
  const underline = (level === 1 ? "=" : "-").repeat(3)
  const line = buffer.lineBoundsAt()
  const title = line.text.trim() || "Heading"
  buffer.replaceRange(line.start, line.end, `${title}\n${underline}`)
  buffer.point = line.start + title.length
}

function changeHeaderLevel(buffer: BufferModel, delta: number): void {
  const line = buffer.lineBoundsAt()
  const match = line.text.match(/^(\s*)(#{1,6})(\s*)(.*)$/)
  if (!match) return
  const level = Math.min(6, Math.max(1, match[2]!.length + delta))
  const replacement = `${match[1]}${"#".repeat(level)}${match[3]}${match[4]}`
  buffer.replaceRange(line.start, line.end, replacement)
}

type MarkdownEditResult = { changed: boolean; message: string }
type MarkdownListItem = { line: number; endLine: number; indent: number }
type MarkdownTableAlignment = "left" | "center" | "right" | "none"
type MarkdownTableCell = { text: string; start: number; end: number }
type MarkdownTableRow = { line: number; raw: string; cells: MarkdownTableCell[]; delimiter: boolean }
type MarkdownTable = {
  startLine: number
  endLine: number
  startOffset: number
  indent: string
  rows: MarkdownTableRow[]
  alignments: MarkdownTableAlignment[]
}

function markdownHeadingAtPointIncludingSetextUnderline(text: string, point: number): MarkdownHeading | null {
  const line = text.slice(0, point).split("\n").length - 1
  return markdownParseHeadings(text).find(h => h.line === line || (h.line + 1 === line && isSetextUnderlineLine(text, line))) ?? null
}

function isSetextUnderlineLine(text: string, line: number): boolean {
  const lines = text.split("\n")
  return line > 0 && line < lines.length && SETEXT_UNDERLINE_RE.test(lines[line]!) && !!lines[line - 1]!.trim()
}

function lineStartAt(text: string, line: number): number {
  if (line <= 0) return 0
  let offset = 0
  const lines = text.split("\n")
  for (let i = 0; i < line && i < lines.length; i++) offset += lines[i]!.length + 1
  return Math.min(offset, text.length)
}

function replaceLines(buffer: BufferModel, startLine: number, endLine: number, replacement: string[]): void {
  const lines = buffer.text.split("\n")
  lines.splice(startLine, endLine - startLine + 1, ...replacement)
  buffer.replaceRange(0, buffer.text.length, lines.join("\n"))
}

function lineHasTablePipe(line: string): boolean {
  return /^(?:[ \t]*)\S.*\|/.test(line) || /^(?:[ \t]*)\|/.test(line)
}

function splitMarkdownTableCells(line: string): MarkdownTableCell[] {
  const indentLen = line.match(/^\s*/)?.[0].length ?? 0
  let start = indentLen
  let end = line.length
  if (line[start] === "|") start++
  while (end > start && /\s/.test(line[end - 1]!)) end--
  if (end > start && line[end - 1] === "|" && !isEscaped(line, end - 1)) end--

  const cells: MarkdownTableCell[] = []
  let cellStart = start
  for (let i = start; i <= end; i++) {
    if (i === end || (line[i] === "|" && !isEscaped(line, i))) {
      const rawStart = cellStart
      const rawEnd = i
      const raw = line.slice(rawStart, rawEnd)
      const left = raw.match(/^\s*/)?.[0].length ?? 0
      const right = raw.match(/\s*$/)?.[0].length ?? 0
      const empty = raw.trim().length === 0
      cells.push({
        text: raw.trim(),
        start: empty ? Math.min(rawStart + 1, rawEnd) : rawStart + left,
        end: empty ? Math.min(rawStart + 1, rawEnd) : rawEnd - right,
      })
      cellStart = i + 1
    }
  }
  return cells
}

function isEscaped(text: string, index: number): boolean {
  let count = 0
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) count++
  return count % 2 === 1
}

function delimiterAlignment(cell: string): MarkdownTableAlignment | null {
  const trimmed = cell.trim()
  if (!/^:?-+:?$/.test(trimmed)) return null
  const left = trimmed.startsWith(":")
  const right = trimmed.endsWith(":")
  if (left && right) return "center"
  if (right) return "right"
  if (left) return "left"
  return "none"
}

function markdownTableAtPoint(text: string, point: number): MarkdownTable | null {
  const lines = text.split("\n")
  const line = text.slice(0, point).split("\n").length - 1
  if (!lineHasTablePipe(lines[line] ?? "")) return null

  let startLine = line
  while (startLine > 0 && lineHasTablePipe(lines[startLine - 1] ?? "")) startLine--
  let endLine = line
  while (endLine + 1 < lines.length && lineHasTablePipe(lines[endLine + 1] ?? "")) endLine++

  const indent = lines[startLine]?.match(/^\s*/)?.[0] ?? ""
  const rows = lines.slice(startLine, endLine + 1).map((raw, i) => {
    const cells = splitMarkdownTableCells(raw)
    return {
      line: startLine + i,
      raw,
      cells,
      delimiter: cells.length > 0 && cells.every(cell => delimiterAlignment(cell.text) != null),
    }
  })
  if (!rows.length || rows.some(row => row.cells.length === 0)) return null

  const delimiter = rows.find(row => row.delimiter)
  const columnCount = Math.max(...rows.map(row => row.cells.length), delimiter?.cells.length ?? 0)
  const alignments: MarkdownTableAlignment[] = Array.from({ length: columnCount }, (_, i) =>
    delimiterAlignment(delimiter?.cells[i]?.text ?? "") ?? "none")

  return { startLine, endLine, startOffset: lineStartAt(text, startLine), indent, rows, alignments }
}

export function markdownInTable(buffer: BufferModel): boolean {
  return markdownTableAtPoint(buffer.text, buffer.point) != null
}

function normalizedMarkdownTableRows(table: MarkdownTable, rows = table.rows): string[] {
  const columnCount = Math.max(1, ...rows.map(row => row.cells.length), table.alignments.length)
  const widths = Array.from({ length: columnCount }, (_, col) => {
    const cellWidth = Math.max(0, ...rows
      .filter(row => !row.delimiter)
      .map(row => row.cells[col]?.text.length ?? 0))
    return Math.max(3, cellWidth)
  })

  return rows.map(row => {
    const parts = widths.map((width, col) => {
      if (row.delimiter) return formatDelimiterCell(width, table.alignments[col] ?? "none")
      const text = row.cells[col]?.text ?? ""
      return ` ${text}${" ".repeat(width - text.length)} `
    })
    return `${table.indent}|${parts.join("|")}|`
  })
}

function formatDelimiterCell(width: number, alignment: MarkdownTableAlignment): string {
  const inner = Math.max(3, width)
  if (alignment === "left") return ` :${"-".repeat(inner - 1)} `
  if (alignment === "center") return ` :${"-".repeat(Math.max(1, inner - 2))}: `
  if (alignment === "right") return ` ${"-".repeat(inner - 1)}: `
  return ` ${"-".repeat(inner)} `
}

function replaceMarkdownTable(buffer: BufferModel, table: MarkdownTable, rows: MarkdownTableRow[], pointCell?: { row: number; col: number }): MarkdownTable {
  const replacement = normalizedMarkdownTableRows(table, rows)
  replaceLines(buffer, table.startLine, table.endLine, replacement)
  if (pointCell) {
    const line = Math.min(table.startLine + pointCell.row, table.startLine + replacement.length - 1)
    const col = Math.max(0, pointCell.col)
    const row = splitMarkdownTableCells(replacement[line - table.startLine] ?? "")
    const cell = row[Math.min(col, Math.max(0, row.length - 1))]
    buffer.point = lineStartAt(buffer.text, line) + (cell?.start ?? table.indent.length + 2)
  } else {
    buffer.point = Math.min(buffer.point, buffer.text.length)
  }
  return markdownTableAtPoint(buffer.text, buffer.point) ?? table
}

export function markdownTableAlign(buffer: BufferModel): MarkdownEditResult {
  const table = markdownTableAtPoint(buffer.text, buffer.point)
  if (!table) return { changed: false, message: "No table at point" }
  const current = currentMarkdownTableCell(table, buffer.point)
  replaceMarkdownTable(buffer, table, table.rows, current ? { row: current.rowIndex, col: current.colIndex } : undefined)
  return { changed: true, message: "Aligned table" }
}

function markdownTableColumnCount(table: MarkdownTable): number {
  return Math.max(1, ...table.rows.map(row => row.cells.length), table.alignments.length)
}

function markdownTableEditableRows(table: MarkdownTable): MarkdownTableRow[] {
  return table.rows.filter(row => !row.delimiter)
}

function makeMarkdownTableRow(table: MarkdownTable, rowIndex: number, cells: string[], delimiter = false): MarkdownTableRow {
  return {
    line: table.startLine + rowIndex,
    raw: "",
    delimiter,
    cells: cells.map(text => ({ text, start: 0, end: text.length })),
  }
}

function renumberMarkdownTableRows(table: MarkdownTable, rows: MarkdownTableRow[]): MarkdownTableRow[] {
  return rows.map((row, i) => ({ ...row, line: table.startLine + i }))
}

export function markdownTableForwardCell(buffer: BufferModel): MarkdownEditResult {
  let result = markdownTableAlign(buffer)
  if (!result.changed) return result
  let table = markdownTableAtPoint(buffer.text, buffer.point)
  if (!table) return { changed: false, message: "No table at point" }
  const current = currentMarkdownTableCell(table, buffer.point)
  const columns = markdownTableColumnCount(table)
  if (!current) return { changed: false, message: "No table cell at point" }

  for (let row = current.rowIndex; row < table.rows.length; row++) {
    const rowInfo = table.rows[row]!
    if (rowInfo.delimiter) continue
    const startCol = row === current.rowIndex ? current.colIndex + 1 : 0
    if (startCol < columns) {
      replaceMarkdownTable(buffer, table, table.rows, { row, col: startCol })
      return { changed: true, message: "Moved to next table cell" }
    }
  }

  const insertAt = table.rows.length
  const empty = makeMarkdownTableRow(table, insertAt, Array.from({ length: columns }, () => ""))
  const rows = renumberMarkdownTableRows(table, [...table.rows, empty])
  table = replaceMarkdownTable(buffer, table, rows, { row: insertAt, col: 0 })
  result = table ? { changed: true, message: "Inserted table row" } : result
  return result
}

export function markdownTableBackwardCell(buffer: BufferModel): MarkdownEditResult {
  const result = markdownTableAlign(buffer)
  if (!result.changed) return result
  const table = markdownTableAtPoint(buffer.text, buffer.point)
  if (!table) return { changed: false, message: "No table at point" }
  const current = currentMarkdownTableCell(table, buffer.point)
  const columns = markdownTableColumnCount(table)
  if (!current) return { changed: false, message: "No table cell at point" }

  for (let row = current.rowIndex; row >= 0; row--) {
    const rowInfo = table.rows[row]!
    if (rowInfo.delimiter) continue
    const startCol = row === current.rowIndex ? current.colIndex - 1 : columns - 1
    if (startCol >= 0) {
      replaceMarkdownTable(buffer, table, table.rows, { row, col: startCol })
      return { changed: true, message: "Moved to previous table cell" }
    }
  }
  return { changed: false, message: "No previous table cell" }
}

function markdownTableCurrentRowIndex(table: MarkdownTable, point: number): number {
  return currentMarkdownTableCell(table, point)?.rowIndex ?? 0
}

function markdownTableCurrentColumnIndex(table: MarkdownTable, point: number): number {
  return currentMarkdownTableCell(table, point)?.colIndex ?? 0
}

export function markdownInsertTable(buffer: BufferModel, rows: number, columns: number): MarkdownEditResult {
  const rowCount = Math.max(1, Math.floor(rows))
  const columnCount = Math.max(1, Math.floor(columns))
  const line = buffer.lineBoundsAt()
  const indent = line.text.match(/^\s*/)?.[0] ?? ""
  const table: MarkdownTable = {
    startLine: buffer.lineAt(buffer.point),
    endLine: buffer.lineAt(buffer.point) + rowCount,
    startOffset: line.start,
    indent,
    alignments: Array.from({ length: columnCount }, () => "none"),
    rows: [],
  }
  const header = makeMarkdownTableRow(table, 0, Array.from({ length: columnCount }, () => ""))
  const delimiter = makeMarkdownTableRow(table, 1, Array.from({ length: columnCount }, () => "---"), true)
  const body = Array.from({ length: Math.max(0, rowCount - 1) }, (_, i) =>
    makeMarkdownTableRow(table, i + 2, Array.from({ length: columnCount }, () => "")))
  table.rows = [header, delimiter, ...body]
  const text = normalizedMarkdownTableRows(table).join("\n")
  const insertion = line.text.trim() ? `${text}\n` : text
  buffer.replaceRange(line.start, line.text.trim() ? line.start : line.end, insertion)
  buffer.point = line.start + indent.length + 2
  return { changed: true, message: "Inserted table" }
}

export function markdownTableInsertRow(buffer: BufferModel): MarkdownEditResult {
  const table = markdownTableAtPoint(buffer.text, buffer.point)
  if (!table) return { changed: false, message: "No table at point" }
  const row = markdownTableCurrentRowIndex(table, buffer.point)
  const columns = markdownTableColumnCount(table)
  const insertAt = table.rows[row]?.delimiter ? row + 1 : row
  const empty = makeMarkdownTableRow(table, insertAt, Array.from({ length: columns }, () => ""))
  const rows = renumberMarkdownTableRows(table, [...table.rows.slice(0, insertAt), empty, ...table.rows.slice(insertAt)])
  replaceMarkdownTable(buffer, table, rows, { row: insertAt, col: 0 })
  return { changed: true, message: "Inserted table row" }
}

export function markdownTableDeleteRow(buffer: BufferModel): MarkdownEditResult {
  const table = markdownTableAtPoint(buffer.text, buffer.point)
  if (!table) return { changed: false, message: "No table at point" }
  const row = markdownTableCurrentRowIndex(table, buffer.point)
  if (table.rows[row]?.delimiter) return { changed: false, message: "Cannot delete delimiter row" }
  if (markdownTableEditableRows(table).length <= 1) return { changed: false, message: "Cannot delete only table row" }
  const rows = renumberMarkdownTableRows(table, table.rows.filter((_, i) => i !== row))
  replaceMarkdownTable(buffer, table, rows, { row: Math.min(row, rows.length - 1), col: 0 })
  return { changed: true, message: "Deleted table row" }
}

export function markdownTableInsertColumn(buffer: BufferModel): MarkdownEditResult {
  const table = markdownTableAtPoint(buffer.text, buffer.point)
  if (!table) return { changed: false, message: "No table at point" }
  const col = markdownTableCurrentColumnIndex(table, buffer.point)
  const columns = markdownTableColumnCount(table)
  const rows = table.rows.map((row, rowIndex) => {
    const cells = Array.from({ length: columns }, (_, i) => row.cells[i]?.text ?? "")
    cells.splice(col, 0, row.delimiter ? "---" : "")
    return makeMarkdownTableRow(table, rowIndex, cells, row.delimiter)
  })
  table.alignments.splice(col, 0, "none")
  replaceMarkdownTable(buffer, table, rows, { row: markdownTableCurrentRowIndex(table, buffer.point), col })
  return { changed: true, message: "Inserted table column" }
}

export function markdownTableDeleteColumn(buffer: BufferModel): MarkdownEditResult {
  const table = markdownTableAtPoint(buffer.text, buffer.point)
  if (!table) return { changed: false, message: "No table at point" }
  const columns = markdownTableColumnCount(table)
  if (columns <= 1) return { changed: false, message: "Cannot delete only table column" }
  const col = markdownTableCurrentColumnIndex(table, buffer.point)
  const rows = table.rows.map((row, rowIndex) => {
    const cells = Array.from({ length: columns }, (_, i) => row.cells[i]?.text ?? "")
    cells.splice(col, 1)
    return makeMarkdownTableRow(table, rowIndex, cells, row.delimiter)
  })
  table.alignments.splice(col, 1)
  replaceMarkdownTable(buffer, table, rows, { row: markdownTableCurrentRowIndex(table, buffer.point), col: Math.min(col, columns - 2) })
  return { changed: true, message: "Deleted table column" }
}

export function markdownTableMoveRow(buffer: BufferModel, direction: -1 | 1): MarkdownEditResult {
  const table = markdownTableAtPoint(buffer.text, buffer.point)
  if (!table) return { changed: false, message: "No table at point" }
  const row = markdownTableCurrentRowIndex(table, buffer.point)
  if (table.rows[row]?.delimiter) return { changed: false, message: "Cannot move delimiter row" }
  let target = row + direction
  while (target >= 0 && target < table.rows.length && table.rows[target]?.delimiter) target += direction
  if (target < 0 || target >= table.rows.length) return { changed: false, message: direction < 0 ? "No previous table row" : "No next table row" }
  const rows = [...table.rows]
  const [moved] = rows.splice(row, 1)
  rows.splice(target, 0, moved!)
  replaceMarkdownTable(buffer, table, renumberMarkdownTableRows(table, rows), { row: target, col: markdownTableCurrentColumnIndex(table, buffer.point) })
  return { changed: true, message: direction < 0 ? "Moved table row up" : "Moved table row down" }
}

export function markdownTableMoveColumn(buffer: BufferModel, direction: -1 | 1): MarkdownEditResult {
  const table = markdownTableAtPoint(buffer.text, buffer.point)
  if (!table) return { changed: false, message: "No table at point" }
  const columns = markdownTableColumnCount(table)
  const col = markdownTableCurrentColumnIndex(table, buffer.point)
  const target = col + direction
  if (target < 0 || target >= columns) return { changed: false, message: direction < 0 ? "No previous table column" : "No next table column" }
  const rows = table.rows.map((row, rowIndex) => {
    const cells = Array.from({ length: columns }, (_, i) => row.cells[i]?.text ?? "")
    const [moved] = cells.splice(col, 1)
    cells.splice(target, 0, moved ?? "")
    return makeMarkdownTableRow(table, rowIndex, cells, row.delimiter)
  })
  const [alignment] = table.alignments.splice(col, 1)
  table.alignments.splice(target, 0, alignment ?? "none")
  replaceMarkdownTable(buffer, table, rows, { row: markdownTableCurrentRowIndex(table, buffer.point), col: target })
  return { changed: true, message: direction < 0 ? "Moved table column left" : "Moved table column right" }
}

function currentMarkdownTableCell(table: MarkdownTable, point: number): { rowIndex: number; colIndex: number } | null {
  const lineIndex = table.rows.findIndex(row => {
    const start = tableLineStart(table, row.line)
    return point >= start && point <= start + row.raw.length
  })
  if (lineIndex < 0) return null
  const row = table.rows[lineIndex]!
  const lineStart = tableLineStart(table, row.line)
  const col = point - lineStart
  const idx = row.cells.findIndex(cell => col <= cell.end)
  return { rowIndex: lineIndex, colIndex: idx < 0 ? Math.max(0, row.cells.length - 1) : idx }
}

function tableLineStart(table: MarkdownTable, line: number): number {
  const prefixRows = table.rows.slice(0, Math.max(0, line - table.startLine))
  return table.startOffset + prefixRows.reduce((sum, row) => sum + row.raw.length + 1, 0)
}

function markdownPromoteOrDemote(buffer: BufferModel, delta: -1 | 1): MarkdownEditResult {
  if (currentMarkdownListItem(buffer.text, buffer.point)) {
    return markdownPromoteOrDemoteListItem(buffer, delta)
  }

  const heading = markdownHeadingAtPointIncludingSetextUnderline(buffer.text, buffer.point)
  if (!heading) return { changed: false, message: "No heading or list item at point" }
  return changeMarkdownHeadingLevel(buffer, heading, delta)
}

function markdownPromoteOrDemoteListItem(buffer: BufferModel, delta: -1 | 1): MarkdownEditResult {
  const item = currentMarkdownListItem(buffer.text, buffer.point)
  if (!item) return { changed: false, message: "No list item at point" }
  const range = lineRangeTextBounds(buffer, item.line, item.endLine)
  indentRegion(buffer, range.start, Math.max(range.start, range.end - 1), delta > 0 ? TAB_WIDTH : -TAB_WIDTH)
  buffer.point = lineStartAt(buffer.text, item.line)
  return { changed: true, message: delta > 0 ? "Demoted list item" : "Promoted list item" }
}

function changeMarkdownHeadingLevel(buffer: BufferModel, heading: MarkdownHeading, delta: -1 | 1): MarkdownEditResult {
  const lines = buffer.text.split("\n")
  const line = lines[heading.line] ?? ""
  const atx = line.match(/^(\s*)(#{1,6})(\s+)(.*)$/)
  if (atx) {
    const next = atx[2]!.length + delta
    if (next < 1) return { changed: false, message: "Cannot promote further" }
    if (next > 6) return { changed: false, message: "Cannot demote further" }
    lines[heading.line] = `${atx[1]}${"#".repeat(next)}${atx[3]}${atx[4]}`
    buffer.replaceRange(0, buffer.text.length, lines.join("\n"))
    buffer.point = lineStartAt(buffer.text, heading.line)
    return { changed: true, message: delta > 0 ? "Demoted heading" : "Promoted heading" }
  }

  const underline = lines[heading.line + 1] ?? ""
  const setext = SETEXT_UNDERLINE_RE.exec(underline)
  if (!setext) return { changed: false, message: "No heading at point" }
  const underlineIndent = setext[1] ?? ""
  const underlineText = setext[2] ?? ""
  const width = Math.max(3, underlineText.length)
  if (delta < 0) {
    if (heading.level <= 1) return { changed: false, message: "Cannot promote further" }
    lines[heading.line + 1] = `${underlineIndent}${"=".repeat(width)}`
    buffer.replaceRange(0, buffer.text.length, lines.join("\n"))
    buffer.point = lineStartAt(buffer.text, heading.line)
    return { changed: true, message: "Promoted heading" }
  }
  if (heading.level === 1) {
    lines[heading.line + 1] = `${underlineIndent}${"-".repeat(width)}`
    buffer.replaceRange(0, buffer.text.length, lines.join("\n"))
    buffer.point = lineStartAt(buffer.text, heading.line)
    return { changed: true, message: "Demoted heading" }
  }
  replaceLines(buffer, heading.line, heading.line + 1, [`### ${line.trim()}`])
  buffer.point = lineStartAt(buffer.text, heading.line)
  return { changed: true, message: "Demoted heading" }
}

function markdownPromoteOrDemoteSubtree(buffer: BufferModel, delta: -1 | 1): MarkdownEditResult {
  const root = markdownHeadingAtPointIncludingSetextUnderline(buffer.text, buffer.point)
  if (!root) return { changed: false, message: "No heading at point" }
  const headings = markdownParseHeadings(buffer.text)
  const lineCount = buffer.text.split("\n").length
  const endLine = markdownSubtreeEndLine(headings, root, lineCount)
  const subtree = headings.filter(h => h.line >= root.line && h.line <= endLine)
  if (delta < 0 && root.level <= 1) return { changed: false, message: "Cannot promote subtree further" }
  if (delta > 0 && subtree.some(h => h.level >= 6)) return { changed: false, message: "Cannot demote subtree further" }
  for (const heading of [...subtree].sort((a, b) => b.line - a.line)) {
    changeMarkdownHeadingLevel(buffer, heading, delta)
  }
  buffer.point = lineStartAt(buffer.text, root.line)
  return { changed: true, message: delta > 0 ? "Demoted subtree" : "Promoted subtree" }
}

function lineRangeTextBounds(buffer: BufferModel, startLine: number, endLine: number): { start: number; end: number } {
  const [start] = buffer.lineBounds(startLine)
  const [, endNoNewline] = buffer.lineBounds(endLine)
  return { start, end: endNoNewline < buffer.text.length ? endNoNewline + 1 : endNoNewline }
}

function markdownMoveSubtree(buffer: BufferModel, direction: -1 | 1): MarkdownEditResult {
  const heading = markdownHeadingAtPointIncludingSetextUnderline(buffer.text, buffer.point)
  if (!heading) return { changed: false, message: "No heading at point" }
  const headings = markdownParseHeadings(buffer.text)
  const lineCount = buffer.text.split("\n").length
  const currentEnd = markdownSubtreeEndLine(headings, heading, lineCount)
  const siblings = headings.filter(h => h.level === heading.level && h.line !== heading.line)
  const blocksLowerLevel = (fromLine: number, toLine: number) =>
    headings.some(h => h.line > fromLine && h.line < toLine && h.level < heading.level)
  const sibling = direction < 0
    ? [...siblings].reverse().find(h => h.line < heading.line && !blocksLowerLevel(h.line, heading.line))
    : siblings.find(h => h.line > currentEnd && !blocksLowerLevel(heading.line, h.line))
  if (!sibling) return { changed: false, message: direction < 0 ? "No previous subtree" : "No next subtree" }

  const siblingEnd = markdownSubtreeEndLine(headings, sibling, lineCount)
  if (direction < 0) {
    swapLineRanges(buffer, sibling.line, siblingEnd, heading.line, currentEnd)
    buffer.point = lineStartAt(buffer.text, sibling.line)
  } else {
    swapLineRanges(buffer, heading.line, currentEnd, sibling.line, siblingEnd)
    const movedLine = sibling.line + (siblingEnd - sibling.line + 1)
    buffer.point = lineStartAt(buffer.text, movedLine)
  }
  return { changed: true, message: direction < 0 ? "Moved subtree up" : "Moved subtree down" }
}

function parseMarkdownListItems(text: string): MarkdownListItem[] {
  const lines = text.split("\n")
  const starts: MarkdownListItem[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(LIST_RE)
    if (match) starts.push({ line: i, endLine: i, indent: match[1]!.length })
  }
  for (let i = 0; i < starts.length; i++) {
    const item = starts[i]!
    let end = lines.length - 1
    for (let j = i + 1; j < starts.length; j++) {
      if (starts[j]!.indent <= item.indent) {
        end = starts[j]!.line - 1
        break
      }
    }
    item.endLine = end
  }
  return starts
}

function currentMarkdownListItem(text: string, point: number): MarkdownListItem | null {
  const line = text.slice(0, point).split("\n").length - 1
  return parseMarkdownListItems(text)
    .filter(item => item.line <= line && item.endLine >= line)
    .sort((a, b) => b.line - a.line)[0] ?? null
}

function markdownMoveListItem(buffer: BufferModel, direction: -1 | 1): MarkdownEditResult {
  const current = currentMarkdownListItem(buffer.text, buffer.point)
  if (!current) return { changed: false, message: "No list item at point" }
  const items = parseMarkdownListItems(buffer.text)
  const blocksAncestor = (fromLine: number, toLine: number) =>
    items.some(item => item.line > fromLine && item.line < toLine && item.indent < current.indent)
  const sibling = direction < 0
    ? [...items].reverse().find(item => item.indent === current.indent && item.endLine < current.line && !blocksAncestor(item.line, current.line))
    : items.find(item => item.indent === current.indent && item.line > current.endLine && !blocksAncestor(current.line, item.line))
  if (!sibling) return { changed: false, message: direction < 0 ? "No previous list item" : "No next list item" }

  if (direction < 0) {
    swapLineRanges(buffer, sibling.line, sibling.endLine, current.line, current.endLine)
    buffer.point = lineStartAt(buffer.text, sibling.line)
  } else {
    swapLineRanges(buffer, current.line, current.endLine, sibling.line, sibling.endLine)
    const movedLine = sibling.line + (sibling.endLine - sibling.line + 1)
    buffer.point = lineStartAt(buffer.text, movedLine)
  }
  return { changed: true, message: direction < 0 ? "Moved list item up" : "Moved list item down" }
}

function swapLineRanges(buffer: BufferModel, aStartLine: number, aEndLine: number, bStartLine: number, bEndLine: number): void {
  const a = lineRangeTextBounds(buffer, aStartLine, aEndLine)
  const b = lineRangeTextBounds(buffer, bStartLine, bEndLine)
  const aText = buffer.text.slice(a.start, a.end)
  const between = buffer.text.slice(a.end, b.start)
  const bText = buffer.text.slice(b.start, b.end)
  buffer.replaceRange(a.start, b.end, `${bText}${between}${aText}`)
}

function indentRegion(buffer: BufferModel, start: number, end: number, delta: number): void {
  const lines = buffer.text.split("\n")
  let offset = 0
  const startLine = buffer.text.slice(0, start).split("\n").length - 1
  const endLine = buffer.text.slice(0, end).split("\n").length - 1
  for (let i = 0; i < lines.length; i++) {
    const lineStart = offset
    const lineEndPos = offset + lines[i]!.length
    if (i >= startLine && i <= endLine) {
      if (delta > 0) lines[i] = " ".repeat(delta) + lines[i]
      else lines[i] = lines[i]!.replace(new RegExp(`^ {0,${-delta}}`), "")
    }
    offset = lineEndPos + 1
  }
  buffer.replaceRange(0, buffer.text.length, lines.join("\n"))
}

function regionBounds(buffer: BufferModel): { start: number; end: number } {
  if (buffer.mark != null && buffer.mark !== buffer.point) {
    return { start: Math.min(buffer.mark, buffer.point), end: Math.max(buffer.mark, buffer.point) }
  }
  const line = buffer.lineBoundsAt()
  return { start: line.start, end: line.end < buffer.text.length ? line.end + 1 : line.end }
}

function activeRegion(buffer: BufferModel): { start: number; end: number } | null {
  if (buffer.mark == null || buffer.mark === buffer.point) return null
  return { start: Math.min(buffer.mark, buffer.point), end: Math.max(buffer.mark, buffer.point) }
}

function findParagraphBoundary(text: string, point: number, direction: 1 | -1): number {
  let offset = point
  const atBlank = isBlankLine(text, offset)
  if (direction === 1) {
    if (!atBlank) offset = nextLineStart(text, offset)
    while (offset < text.length && !isBlankLine(text, offset)) offset = nextLineStart(text, offset)
    while (offset < text.length && isBlankLine(text, offset)) offset = nextLineStart(text, offset)
    return Math.min(offset, text.length)
  }
  if (!atBlank) offset = previousLineStart(text, offset) ?? 0
  while (offset > 0 && !isBlankLine(text, offset)) offset = previousLineStart(text, offset) ?? 0
  while (offset > 0 && isBlankLine(text, offset)) offset = previousLineStart(text, offset) ?? 0
  return offset
}

function findHeading(text: string, point: number, direction: 1 | -1, sameLevel: boolean, level?: number): number {
  const positions = markdownParseHeadings(text).map(h => ({ index: h.start, level: h.level }))
  if (direction === 1) {
    for (const pos of positions) {
      if (pos.index <= point) continue
      if (sameLevel && level != null && pos.level !== level) continue
      return pos.index
    }
    return text.length
  }
  let target = 0
  for (const pos of positions) {
    if (pos.index >= point) break
    if (sameLevel && level != null && pos.level !== level) continue
    target = pos.index
  }
  return target
}

function headingLevelAt(text: string, point: number): number {
  return markdownHeadingAtPoint(text, point)?.level ?? 1
}

type MarkdownLink = {
  start: number
  end: number
  kind: "inline" | "auto" | "reference"
  url: string | null
  label?: string
  definitionStart?: number
}

type ReferenceDefinition = {
  label: string
  normalized: string
  url: string
  start: number
  textStart: number
  end: number
}

type FootnotePosition = {
  label: string
  start: number
  end: number
}

type FootnoteDefinition = FootnotePosition & {
  textStart: number
}

const INLINE_OR_AUTO_LINK_RE = /!?\[[^\]]*\]\(([^)]+)\)|<((?:https?:\/\/|mailto:)[^>]+)>/g
const REFERENCE_LINK_RE = /!?\[([^\]\n]*)\]\[([^\]\n]*)\]/g

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
}

function markdownUriTypes(): string[] {
  const raw = getCustom<string[]>("markdown-uri-types") ?? DEFAULT_MARKDOWN_URI_TYPES
  return raw.filter(item => typeof item === "string" && item.length > 0)
}

function trimBareUrlEnd(url: string): string {
  let out = url.replace(/[.,;:!?]+$/g, "")
  for (;;) {
    const last = out.at(-1)
    if (last === ")" && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) out = out.slice(0, -1)
    else if (last === "]" && (out.match(/\[/g)?.length ?? 0) < (out.match(/\]/g)?.length ?? 0)) out = out.slice(0, -1)
    else if (last === "}" && (out.match(/\{/g)?.length ?? 0) < (out.match(/\}/g)?.length ?? 0)) out = out.slice(0, -1)
    else break
  }
  return out
}

function markdownBareUrlLinks(text: string, covered: Array<[number, number]>): MarkdownLink[] {
  const schemes = markdownUriTypes().map(escapeRegExp).join("|")
  if (!schemes) return []
  const re = new RegExp(`(^|[^\\w@])((?:${schemes}):[^\\s<>"']+)`, "gi")
  const links: MarkdownLink[] = []
  const codeRanges: Array<readonly [number, number]> = parseFencedCodeBlocks(text).map(block => [block.bodyStart, block.bodyEnd] as const)
  let offset = 0
  for (const line of text.split("\n")) {
    codeRanges.push(...protectedInlineCodeRanges(line, offset))
    offset += line.length + 1
  }
  for (const match of text.matchAll(re)) {
    if (match.index == null) continue
    const raw = match[2] ?? ""
    const url = trimBareUrlEnd(raw)
    if (!url) continue
    const start = match.index + (match[1]?.length ?? 0)
    const end = start + url.length
    if (spanInsideRegions(start, end, covered) || spanInsideRegions(start, end, codeRanges)) continue
    links.push({ start, end, kind: "auto", url })
  }
  return links
}

function findLink(text: string, point: number, direction: 1 | -1, includeBare = false): number | null {
  const matches = markdownLinks(text, includeBare).map(link => ({ index: link.start }))
  if (direction === 1) {
    for (const m of matches) if (m.index > point) return m.index
    return null
  }
  let prev: number | null = null
  for (const m of matches) {
    if (m.index >= point) break
    prev = m.index
  }
  return prev
}

function linkAtPoint(text: string, point: number, includeBare = false): MarkdownLink | null {
  return markdownLinks(text, includeBare).find(link => point >= link.start && point <= link.end) ?? null
}

function markdownLinks(text: string, includeBare = false): MarkdownLink[] {
  const definitions = referenceDefinitionMap(text)
  const links: MarkdownLink[] = []
  for (const match of text.matchAll(INLINE_OR_AUTO_LINK_RE)) {
    if (match.index == null) continue
    links.push({
      start: match.index,
      end: match.index + match[0].length,
      kind: match[2] ? "auto" : "inline",
      url: match[1] ?? match[2] ?? null,
    })
  }
  for (const match of text.matchAll(REFERENCE_LINK_RE)) {
    if (match.index == null) continue
    const textLabel = match[1] ?? ""
    const rawLabel = match[2] || textLabel
    if (!rawLabel || rawLabel.startsWith("^")) continue
    const def = definitions.get(normalizeReferenceLabel(rawLabel))
    links.push({
      start: match.index,
      end: match.index + match[0].length,
      kind: "reference",
      label: rawLabel,
      url: def?.url ?? null,
      definitionStart: def?.start,
    })
  }
  if (includeBare) {
    const covered = links.map(link => [link.start, link.end] as [number, number])
    links.push(...markdownBareUrlLinks(text, covered))
  }
  return links.sort((a, b) => a.start - b.start || a.end - b.end)
}

function normalizeReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase()
}

function referenceDefinitionMap(text: string): Map<string, ReferenceDefinition> {
  const out = new Map<string, ReferenceDefinition>()
  for (const def of referenceDefinitions(text)) {
    if (!out.has(def.normalized)) out.set(def.normalized, def)
  }
  return out
}

function referenceDefinitions(text: string): ReferenceDefinition[] {
  const out: ReferenceDefinition[] = []
  const re = /^( {0,3})\[([^\]\n]+)\]:[ \t]*(\S.*)?$/gm
  for (const match of text.matchAll(re)) {
    if (match.index == null) continue
    const label = match[2] ?? ""
    if (label.startsWith("^")) continue
    const prefixLength = (match[1]?.length ?? 0) + label.length + 3
    const url = (match[3] ?? "").trim()
    out.push({
      label,
      normalized: normalizeReferenceLabel(label),
      url,
      start: match.index,
      textStart: match.index + prefixLength + ((match[0].slice(prefixLength).match(/^[ \t]*/)?.[0].length) ?? 0),
      end: match.index + match[0].length,
    })
  }
  return out
}

function findReferenceDefinition(text: string, label: string): ReferenceDefinition | null {
  return referenceDefinitionMap(text).get(normalizeReferenceLabel(label)) ?? null
}

function nextFootnoteNumber(text: string): string {
  const used = new Set<number>()
  for (const match of text.matchAll(/\[\^(\d+)\]/g)) {
    const n = Number.parseInt(match[1] ?? "", 10)
    if (Number.isFinite(n)) used.add(n)
  }
  let next = 1
  while (used.has(next)) next++
  return String(next)
}

function footnoteMarkerAtPoint(text: string, point: number): FootnotePosition | null {
  for (const match of text.matchAll(/\[\^([^\]\n]+)\]/g)) {
    if (match.index == null) continue
    const start = match.index
    const end = start + match[0].length
    if (point < start || point > end) continue
    const line = text.slice(text.lastIndexOf("\n", Math.max(0, start - 1)) + 1, lineEnd(text, start))
    if (/^\s*\[\^[^\]\n]+\]:/.test(line)) continue
    return { label: match[1] ?? "", start, end }
  }
  return null
}

function findFootnoteMarker(text: string, label: string): FootnotePosition | null {
  for (const match of text.matchAll(/\[\^([^\]\n]+)\]/g)) {
    if (match.index == null || match[1] !== label) continue
    const line = text.slice(text.lastIndexOf("\n", Math.max(0, match.index - 1)) + 1, lineEnd(text, match.index))
    if (/^\s*\[\^[^\]\n]+\]:/.test(line)) continue
    return { label, start: match.index, end: match.index + match[0].length }
  }
  return null
}

function findFootnoteDefinition(text: string, label: string): FootnoteDefinition | null {
  return footnoteDefinitions(text).find(def => def.label === label) ?? null
}

function footnoteDefinitionAtPoint(text: string, point: number): FootnoteDefinition | null {
  return footnoteDefinitions(text).find(def => point >= def.start && point <= def.end) ?? null
}

function footnoteDefinitions(text: string): FootnoteDefinition[] {
  const out: FootnoteDefinition[] = []
  const re = /^( {0,3})\[\^([^\]\n]+)\]:[ \t]*/gm
  for (const match of text.matchAll(re)) {
    if (match.index == null) continue
    const start = match.index
    const textStart = start + match[0].length
    out.push({
      label: match[2] ?? "",
      start,
      textStart,
      end: lineEnd(text, start),
    })
  }
  return out
}

function findCurrentParagraphEnd(text: string, point: number): number {
  let start = point <= 0 ? 0 : text.lastIndexOf("\n", point - 1) + 1
  if (isBlankLine(text, start)) return lineEnd(text, start)
  while (start > 0) {
    const prev = previousLineStart(text, start)
    if (prev == null || isBlankLine(text, prev)) break
    start = prev
  }
  let end = lineEnd(text, start)
  while (end < text.length) {
    const next = end + 1
    if (next >= text.length || isBlankLine(text, next)) break
    end = lineEnd(text, next)
  }
  return end
}

const SAFE_URL_SCHEME = /^(https?|mailto):/i

function markdownOpenExternal(target: string, deps: MarkdownDeps = {}, allowFile = false): void {
  // The url comes from markdown link text — refuse anything that isn't a
  // browser-safe scheme so `[x](--flag)` or `[x](file:///etc/passwd)` can't
  // reach the OS opener, and `--` stops it being parsed as an option.
  let scheme: string
  try { scheme = new URL(target).protocol } catch { return }
  if (!SAFE_URL_SCHEME.test(scheme) && !(allowFile && scheme === "file:")) return
  if (deps.openExternal) {
    deps.openExternal(target, { allowFile })
    return
  }
  const platform = process.platform
  const cmd = platform === "darwin" ? ["open", "--", target]
    : platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", target]
    : ["xdg-open", "--", target]
  try { spawnProcess({ cmd }) } catch { /* best effort */ }
}

function isBlankLine(text: string, offset: number): boolean {
  const start = offset <= 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1
  const end = lineEnd(text, start)
  return text.slice(start, end).trim() === ""
}

function previousLineStart(text: string, lineStart: number): number | null {
  if (lineStart <= 0) return null
  return text.lastIndexOf("\n", lineStart - 2) + 1
}

function nextLineStart(text: string, offset: number): number {
  const end = lineEnd(text, offset)
  return end >= text.length ? text.length : end + 1
}

function lineEnd(text: string, start: number): number {
  const end = text.indexOf("\n", start)
  return end === -1 ? text.length : end
}

function lineIndent(text: string, lineStart: number): number {
  const line = text.slice(lineStart, lineEnd(text, lineStart))
  return line.match(/^\s*/)?.[0].length ?? 0
}
