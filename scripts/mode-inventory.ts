#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"

export type ModeDefinition = {
  name: string
  source: string
  line: number
  callee: string
}

export type ModeRoute = {
  pattern: string
  target: "path" | "text"
  mode: string
  source: string
  line: number
}

export type ModeInventory = {
  root: string
  modes: ModeDefinition[]
  modeNames: string[]
  routes: ModeRoute[]
  curatedModes: string[]
  implementedGnuModes: string[]
  missingGnuModes: string[]
  jemacsOnlyModes: string[]
}

export type ModeInventorySnapshot = {
  version: 1
  curatedModes: string[]
  implementedGnuModes: string[]
  missingGnuModes: string[]
}

const SOURCE_DIRS = ["src", "lisp", "plugins"] as const
const REPO_ROOT = join(import.meta.dirname, "..")

export const SNAPSHOT_PATH = join(import.meta.dirname, "mode-inventory-snapshot.json")

export const CURATED_GNU_MODES = uniqueSorted([
  "bash-mode",
  "bibtex-mode",
  "buffer-list",
  "c",
  "c++-mode",
  "c++-ts-mode",
  "c-or-c++-mode",
  "c-ts-mode",
  "change-log-mode",
  "cmake-mode",
  "comint-mode",
  "conf-colon-mode",
  "conf-javaprop-mode",
  "conf-mode",
  "conf-space-mode",
  "conf-unix-mode",
  "conf-windows-mode",
  "css-mode",
  "css-ts-mode",
  "custom-theme-choose-mode",
  "customize-face-mode",
  "customize-mode",
  "diff-mode",
  "dired",
  "dockerfile-mode",
  "emacs-lisp-mode",
  "eshell-mode",
  "go",
  "go-mod-mode",
  "go-sum-mode",
  "grep",
  "grep-mode",
  "help",
  "html",
  "ielm",
  "inferior-lisp-mode",
  "java",
  "javascript",
  "json",
  "latex-mode",
  "lisp-interaction-mode",
  "lisp-mode",
  "log-edit-mode",
  "log-view-mode",
  "makefile-bsdmake-mode",
  "makefile-gmake-mode",
  "makefile-mode",
  "messages-buffer-mode",
  "minibuffer",
  "nroff-mode",
  "nxml-mode",
  "objc-mode",
  "occur-mode",
  "outline-mode",
  "plain-tex-mode",
  "prog-mode",
  "python",
  "rst-mode",
  "rust",
  "scheme-mode",
  "sgml-mode",
  "sh-mode",
  "shell-mode",
  "tabulated-list-mode",
  "term",
  "tex-mode",
  "text",
  "toml-mode",
  "toml-ts-mode",
  "typescript",
  "vc-dir-mode",
  "wdired",
  "xref--xref-buffer-mode",
  "xml-mode",
  "yaml",
])

export function extractModeDefinitions(root = REPO_ROOT): ModeDefinition[] {
  const modes: ModeDefinition[] = []
  for (const file of listSourceFiles(root)) {
    modes.push(...extractModeDefinitionsFromFile(root, file))
  }
  return modes.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source) || a.line - b.line)
}

export function extractInferModeRoutes(root = REPO_ROOT): ModeRoute[] {
  const source = join(root, "src/kernel/buffer.ts")
  const text = readFileSync(source, "utf8")
  const relativeSource = relative(root, source)
  const body = inferModeBody(text)
  const routes: ModeRoute[] = []
  for (const statement of ifReturnStatements(body.text)) {
    const line = lineNumberAt(text, body.offset + statement.index)
    const tests = statement.condition.matchAll(/(\/(?:\\.|[^/\\\n])+\/[dgimsuvy]*)\.test\((path|text)\)/g)
    for (const test of tests) {
      routes.push({
        pattern: test[1]!,
        target: test[2] as "path" | "text",
        mode: statement.mode,
        source: relativeSource,
        line,
      })
    }
  }
  return routes
}

export function buildModeInventory(root = REPO_ROOT): ModeInventory {
  const modes = extractModeDefinitions(root)
  const modeNames = uniqueSorted(modes.map(mode => mode.name))
  const routes = extractInferModeRoutes(root)
  const implemented = new Set(modeNames)
  const curatedModes = CURATED_GNU_MODES
  const implementedGnuModes = curatedModes.filter(mode => implemented.has(mode))
  const missingGnuModes = curatedModes.filter(mode => !implemented.has(mode))
  const curated = new Set(curatedModes)
  const jemacsOnlyModes = modeNames.filter(mode => !curated.has(mode))
  return {
    root,
    modes,
    modeNames,
    routes,
    curatedModes,
    implementedGnuModes,
    missingGnuModes,
    jemacsOnlyModes,
  }
}

export function generateMarkdownReport(inventory: ModeInventory): string {
  const definitions = definitionsByName(inventory.modes)
  return [
    "# Jemacs Mode Inventory",
    "",
    `- Registered modes: ${inventory.modeNames.length}`,
    `- Curated GNU-important modes: ${inventory.curatedModes.length}`,
    `- Implemented curated modes: ${inventory.implementedGnuModes.length}`,
    `- Missing curated modes: ${inventory.missingGnuModes.length}`,
    `- inferMode regex routes: ${inventory.routes.length}`,
    "",
    "## Implemented GNU Modes",
    "",
    modeList(inventory.implementedGnuModes, definitions),
    "",
    "## Missing GNU Modes",
    "",
    plainModeList(inventory.missingGnuModes),
    "",
    "## Jemacs-Only Modes",
    "",
    modeList(inventory.jemacsOnlyModes, definitions),
    "",
    "## Extensions Routed",
    "",
    routeList(inventory.routes),
    "",
  ].join("\n")
}

export function snapshotFromInventory(inventory: ModeInventory): ModeInventorySnapshot {
  return {
    version: 1,
    curatedModes: inventory.curatedModes,
    implementedGnuModes: inventory.implementedGnuModes,
    missingGnuModes: inventory.missingGnuModes,
  }
}

export function writeSnapshot(snapshot: ModeInventorySnapshot, path = SNAPSHOT_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`)
}

export function readSnapshot(path = SNAPSHOT_PATH): ModeInventorySnapshot | null {
  if (!existsSync(path)) return null
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ModeInventorySnapshot
  if (parsed.version !== 1 || !Array.isArray(parsed.curatedModes) || !Array.isArray(parsed.implementedGnuModes)) {
    throw new Error(`Invalid mode inventory snapshot: ${path}`)
  }
  return parsed
}

export function checkInventoryAgainstSnapshot(inventory: ModeInventory, snapshot: ModeInventorySnapshot): string[] {
  const implementedNow = new Set(inventory.implementedGnuModes)
  return snapshot.implementedGnuModes
    .filter(mode => !implementedNow.has(mode))
    .map(mode => `Curated mode regressed from implemented to missing: ${mode}`)
}

export async function main(argv = process.argv.slice(2), root = REPO_ROOT): Promise<number> {
  const updateSnapshot = argv.includes("--update-snapshot")
  const check = argv.includes("--check")
  const inventory = buildModeInventory(root)

  if (updateSnapshot) writeSnapshot(snapshotFromInventory(inventory))

  console.log(generateMarkdownReport(inventory))

  if (!check) return 0
  const snapshot = readSnapshot()
  if (!snapshot) {
    console.error(`Missing ${relative(root, SNAPSHOT_PATH)}; run: bun scripts/mode-inventory.ts --update-snapshot`)
    return 1
  }
  const failures = checkInventoryAgainstSnapshot(inventory, snapshot)
  if (!failures.length) return 0
  for (const failure of failures) console.error(failure)
  return 1
}

function extractModeDefinitionsFromFile(root: string, file: string): ModeDefinition[] {
  const text = readFileSync(file, "utf8")
  const source = relative(root, file)
  const constants = stringConstants(text)
  const definitions: ModeDefinition[] = []

  const defineModeCall = /\bdefineMode\s*\(\s*\{/g
  let match: RegExpExecArray | null
  while ((match = defineModeCall.exec(text))) {
    const slice = text.slice(match.index, match.index + 1600)
    const name = extractObjectName(slice, constants)
    if (!name) continue
    definitions.push({
      name,
      source,
      line: lineNumberAt(text, match.index),
      callee: "defineMode",
    })
  }

  const wrapperCall = /\b(defineCodeMode|defineTreeSitterCodeMode)\s*\(\s*(["'`])([^"'`]+)\2/g
  while ((match = wrapperCall.exec(text))) {
    definitions.push({
      name: match[3]!,
      source,
      line: lineNumberAt(text, match.index),
      callee: match[1]!,
    })
  }

  return definitions
}

function extractObjectName(slice: string, constants: Map<string, string>): string | null {
  const match = /\bname\s*:\s*(?:"([^"]+)"|'([^']+)'|`([^`$]+)`|([A-Za-z_$][\w$]*))/m.exec(slice)
  if (!match) return null
  if (match[1] || match[2] || match[3]) return match[1] ?? match[2] ?? match[3]!
  return constants.get(match[4]!) ?? null
}

function stringConstants(text: string): Map<string, string> {
  const constants = new Map<string, string>()
  const re = /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])((?:\\.|(?!\2)[\s\S])*?)\2\s*(?:as\s+const)?/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const value = match[3]!
    if (!value.includes("${")) constants.set(match[1]!, value)
  }
  return constants
}

function listSourceFiles(root: string): string[] {
  const files: string[] = []
  for (const dir of SOURCE_DIRS) {
    walk(join(root, dir), files)
  }
  return files.sort()
}

function walk(dir: string, files: string[]): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, files)
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(path)
  }
}

function inferModeBody(text: string): { text: string; offset: number } {
  const start = text.indexOf("export function inferMode")
  if (start === -1) throw new Error("Could not find inferMode in src/kernel/buffer.ts")
  const open = text.indexOf("{", start)
  if (open === -1) throw new Error("Could not find inferMode body")
  const close = findMatchingBrace(text, open)
  if (close === -1) throw new Error("Could not find end of inferMode body")
  return { text: text.slice(open + 1, close), offset: open + 1 }
}

function ifReturnStatements(text: string): Array<{ condition: string; mode: string; index: number }> {
  const statements: Array<{ condition: string; mode: string; index: number }> = []
  const ifCall = /\bif\s*\(/g
  let match: RegExpExecArray | null
  while ((match = ifCall.exec(text))) {
    const open = text.indexOf("(", match.index)
    const close = findMatchingParen(text, open)
    if (close === -1) continue
    const after = text.slice(close + 1)
    const ret = /^\s*return\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*(?:\([^)]*\))?))/.exec(after)
    if (!ret) continue
    statements.push({
      condition: text.slice(open + 1, close),
      mode: ret[1] ?? ret[2] ?? ret[3]!,
      index: match.index,
    })
    ifCall.lastIndex = close + 1
  }
  return statements
}

function findMatchingParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!
    if (ch === "\"" || ch === "'" || ch === "`") {
      i = skipString(text, i, ch)
      continue
    }
    if (ch === "/") {
      i = skipRegexLiteral(text, i)
      continue
    }
    if (ch === "(") depth++
    else if (ch === ")") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function skipString(text: string, start: number, quote: string): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++
    else if (text[i] === quote) return i
  }
  return text.length - 1
}

function skipRegexLiteral(text: string, start: number): number {
  let inClass = false
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]!
    if (ch === "\\") {
      i++
      continue
    }
    if (ch === "[") inClass = true
    else if (ch === "]") inClass = false
    else if (ch === "/" && !inClass) {
      while (/[a-z]/i.test(text[i + 1] ?? "")) i++
      return i
    }
  }
  return start
}

function findMatchingBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function definitionsByName(definitions: ModeDefinition[]): Map<string, ModeDefinition[]> {
  const byName = new Map<string, ModeDefinition[]>()
  for (const definition of definitions) {
    const existing = byName.get(definition.name)
    if (existing) existing.push(definition)
    else byName.set(definition.name, [definition])
  }
  return byName
}

function modeList(names: string[], definitions: Map<string, ModeDefinition[]>): string {
  if (!names.length) return "_None._"
  return names.map(name => {
    const locations = definitions.get(name)?.map(def => `${def.source}:${def.line}`).join(", ") ?? "unknown"
    return `- \`${name}\` (${locations})`
  }).join("\n")
}

function plainModeList(names: string[]): string {
  if (!names.length) return "_None._"
  return names.map(name => `- \`${name}\``).join("\n")
}

function routeList(routes: ModeRoute[]): string {
  if (!routes.length) return "_None._"
  return routes
    .map(route => `- \`${route.pattern}\` on \`${route.target}\` -> \`${route.mode}\` (${route.source}:${route.line})`)
    .join("\n")
}

function lineNumberAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++
  }
  return line
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

if (import.meta.main) {
  const code = await main()
  process.exit(code)
}
