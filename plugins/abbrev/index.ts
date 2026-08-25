import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { BufferModel } from "../../src/kernel/buffer"
import type { CommandContext } from "../../src/kernel/command"
import type { Editor } from "../../src/kernel/editor"
import { getTrackedAdvice } from "../../src/runtime/advice"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"

type AbbrevTable = Map<string, string>

type AbbrevState = {
  global: AbbrevTable
  modes: Map<string, AbbrevTable>
}

type SerializedAbbrevs = {
  version: 1
  global: Record<string, string>
  modes: Record<string, Record<string, string>>
}

const STATE_KEY = "abbrev-state"
const WORD_RE = /[A-Za-z0-9_]/

let selfInsertAdviceId: string | undefined

function abbrevFileName(): string {
  return getCustom<string>("abbrev-file-name") ?? join(homedir(), ".jemacs", "abbrevs.json")
}

function state(editor: Editor): AbbrevState {
  const existing = editor.locals.get(STATE_KEY) as AbbrevState | undefined
  if (existing) return existing
  const next: AbbrevState = { global: new Map(), modes: new Map() }
  editor.locals.set(STATE_KEY, next)
  return next
}

function modeTable(editor: Editor, mode: string, create = false): AbbrevTable | undefined {
  const tables = state(editor).modes
  const existing = tables.get(mode)
  if (existing || !create) return existing
  const next: AbbrevTable = new Map()
  tables.set(mode, next)
  return next
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_RE.test(ch)
}

function wordBefore(buffer: BufferModel, before = buffer.point): { start: number; end: number; text: string } | null {
  const text = buffer.text
  let end = Math.max(0, Math.min(before, text.length))
  if (end <= 0 || !isWordChar(text[end - 1])) return null
  let start = end
  while (start > 0 && isWordChar(text[start - 1])) start--
  return { start, end, text: text.slice(start, end) }
}

function lookupAbbrev(editor: Editor, buffer: BufferModel, abbrev: string): string | undefined {
  return modeTable(editor, buffer.mode)?.get(abbrev) ?? state(editor).global.get(abbrev)
}

function defineAbbrev(table: AbbrevTable, abbrev: string, expansion: string, editor: Editor): boolean {
  const name = abbrev.trim()
  if (!name) {
    editor.message("No abbrev specified")
    return false
  }
  table.set(name, expansion)
  editor.message(`Defined ${name}`)
  return true
}

async function defineGlobalAbbrev(editor: Editor, args: string[]): Promise<void> {
  const abbrev = args[0] ?? await editor.prompt("Define global abbrev: ", "", "abbrev")
  if (abbrev == null) return
  const expansion = args[1] ?? await editor.prompt(`Expansion for ${abbrev}: `, "", "abbrev-expansion")
  if (expansion == null) return
  defineAbbrev(state(editor).global, abbrev, expansion, editor)
}

async function defineModeAbbrev(editor: Editor, buffer: BufferModel, args: string[]): Promise<void> {
  const abbrev = args[0] ?? await editor.prompt(`Define ${buffer.mode} abbrev: `, "", "abbrev")
  if (abbrev == null) return
  const expansion = args[1] ?? await editor.prompt(`Expansion for ${abbrev}: `, "", "abbrev-expansion")
  if (expansion == null) return
  defineAbbrev(modeTable(editor, buffer.mode, true)!, abbrev, expansion, editor)
}

async function addAbbrevFromWord(
  editor: Editor,
  buffer: BufferModel,
  table: AbbrevTable,
  prompt: (expansion: string) => string,
  args: string[],
): Promise<void> {
  const bounds = wordBefore(buffer)
  if (!bounds) {
    editor.message("No word before point")
    return
  }
  const abbrev = args[0] ?? await editor.prompt(prompt(bounds.text), "", "abbrev")
  if (abbrev == null) return
  defineAbbrev(table, abbrev, bounds.text, editor)
}

function expandAbbrevAt(editor: Editor, buffer: BufferModel, before = buffer.point, silent = false): boolean {
  const bounds = wordBefore(buffer, before)
  if (!bounds) {
    if (!silent) editor.message("No abbrev before point")
    return false
  }
  const expansion = lookupAbbrev(editor, buffer, bounds.text)
  if (expansion == null) {
    if (!silent) editor.message("No abbrev expansion")
    return false
  }
  buffer.splice(bounds.start, bounds.end, expansion)
  if (!silent) editor.message(`Expanded ${bounds.text}`)
  return true
}

function insertedCharacter({ editor, args, keyEvent, prefixArgument }: CommandContext): string | null {
  if (prefixArgument != null && prefixArgument !== 1) return null
  const ch = args[0] ?? keyEvent?.sequence ?? editor.lastKeyEvent?.sequence
  return ch && ch.length === 1 ? ch : null
}

function postSelfInsert(editor: Editor, buffer: BufferModel, ctx: CommandContext): void {
  if (editor.minibuffer || !editor.isMinorModeEnabled("abbrev-mode", buffer)) return
  const ch = insertedCharacter(ctx)
  if (!ch || isWordChar(ch)) return
  const separatorStart = buffer.point - 1
  if (separatorStart < 0 || buffer.text[separatorStart] !== ch) return
  if (expandAbbrevAt(editor, buffer, separatorStart, true)) buffer.amalgamateUndo()
}

function sortedEntries(table: AbbrevTable): Array<[string, string]> {
  return [...table.entries()].sort(([a], [b]) => a.localeCompare(b))
}

function listAbbrevs(editor: Editor): void {
  const current = state(editor)
  const lines: string[] = []
  const emitTable = (heading: string, table: AbbrevTable) => {
    if (!table.size) return
    if (lines.length) lines.push("")
    lines.push(`${heading}:`)
    for (const [abbrev, expansion] of sortedEntries(table)) lines.push(`  ${abbrev} -> ${expansion}`)
  }

  emitTable("Global abbrevs", current.global)
  for (const [mode, table] of [...current.modes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    emitTable(`${mode} abbrevs`, table)
  }

  editor.scratch("*Abbrevs*", lines.length ? `${lines.join("\n")}\n` : "No abbrevs defined.\n", "text")
}

function tableObject(table: AbbrevTable): Record<string, string> {
  return Object.fromEntries(sortedEntries(table))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readTable(value: unknown): AbbrevTable {
  const table: AbbrevTable = new Map()
  if (!isRecord(value)) return table
  for (const [abbrev, expansion] of Object.entries(value)) {
    if (typeof expansion === "string" && abbrev) table.set(abbrev, expansion)
  }
  return table
}

export async function saveAbbrevs(editor: Editor): Promise<void> {
  const current = state(editor)
  const data: SerializedAbbrevs = {
    version: 1,
    global: tableObject(current.global),
    modes: {},
  }
  for (const [mode, table] of [...current.modes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    data.modes[mode] = tableObject(table)
  }

  const file = abbrevFileName()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(data, null, 2), "utf8")
}

export async function loadAbbrevs(editor: Editor): Promise<void> {
  const text = await readFile(abbrevFileName(), "utf8").catch(() => null)
  if (!text) return

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return
  }
  if (!isRecord(raw)) return

  const current = state(editor)
  current.global = readTable(raw.global)
  current.modes.clear()
  if (isRecord(raw.modes)) {
    for (const [mode, table] of Object.entries(raw.modes)) {
      if (mode) current.modes.set(mode, readTable(table))
    }
  }
}

export async function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): Promise<void> {
  defcustom("abbrev-file-name", "string", join(homedir(), ".jemacs", "abbrevs.json"),
    "File where abbrev tables are persisted.", "files")

  state(editor)
  ctx.minorMode({ name: "abbrev-mode", lighter: " Abbrev" })

  ctx.command("abbrev-mode", ({ editor, buffer, prefixArgument }) => {
    if (prefixArgument === 1) editor.enableMinorMode("abbrev-mode", { buffer })
    else if (prefixArgument === 0 || prefixArgument === -1) editor.disableMinorMode("abbrev-mode", { buffer })
    else editor.toggleMinorMode("abbrev-mode", { buffer })
  }, "Toggle Abbrev mode in the current buffer.")

  ctx.command("add-global-abbrev", ({ editor, buffer, args }) =>
    addAbbrevFromWord(editor, buffer, state(editor).global, expansion => `Global abbrev for "${expansion}": `, args),
  "Define a global abbrev for the word before point.")

  ctx.command("add-mode-abbrev", ({ editor, buffer, args }) =>
    addAbbrevFromWord(editor, buffer, modeTable(editor, buffer.mode, true)!, expansion => `${buffer.mode} abbrev for "${expansion}": `, args),
  "Define a mode-local abbrev for the word before point.")

  ctx.command("define-global-abbrev", ({ editor, args }) => defineGlobalAbbrev(editor, args),
    "Define a global abbrev by reading an abbrev and expansion.")

  ctx.command("define-mode-abbrev", ({ editor, buffer, args }) => defineModeAbbrev(editor, buffer, args),
    "Define a mode-local abbrev by reading an abbrev and expansion.")

  ctx.command("expand-abbrev", ({ editor, buffer }) => {
    expandAbbrevAt(editor, buffer)
  }, "Expand the abbrev before point.")

  ctx.command("list-abbrevs", ({ editor }) => listAbbrevs(editor), "Display all defined abbrevs.")

  ctx.command("kill-all-abbrevs", ({ editor }) => {
    const current = state(editor)
    current.global.clear()
    current.modes.clear()
    editor.message("Killed all abbrevs")
  }, "Remove all abbrev definitions.")

  ctx.key("global-map", "C-x a g", "add-global-abbrev")
  ctx.key("global-map", "C-x a l", "add-mode-abbrev")
  ctx.key("global-map", "C-x a e", "expand-abbrev")
  ctx.key("global-map", "C-x '", "expand-abbrev")

  if (selfInsertAdviceId === undefined || getTrackedAdvice(selfInsertAdviceId) === undefined) {
    selfInsertAdviceId = ctx.advice("self-insert-command", {
      after: ctx => postSelfInsert(ctx.editor, ctx.buffer, ctx),
    })
    ctx.onDispose(() => { selfInsertAdviceId = undefined })
  }

  ctx.hook("kill-emacs-hook", async ({ editor: ed }) => {
    if (ed === editor) await saveAbbrevs(editor)
  })

  await loadAbbrevs(editor)
}
