import type { BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { Keymap } from "../../src/kernel/keymap"
import type { FaceName, TextSpan } from "../../src/modes/mode"
import { spawnProcess, whichExecutable } from "../../src/platform/runtime"
import { defcustom, defvar, getCustom } from "../../src/runtime/custom"
import { defface } from "../../src/runtime/faces"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"

type Awaitable<T> = T | Promise<T>

export type SpellMisspelling = {
  word: string
  start?: number
  end?: number
  suggestions?: string[]
}

export type FlyspellMisspelling = {
  word: string
  start: number
  end: number
  suggestions?: string[]
}

export type SpellBackendResult = SpellMisspelling[] | string[]
export type SpellBackendFn = (text: string) => Awaitable<SpellBackendResult>
export type SpellBackend = {
  name?: string
  check: SpellBackendFn
  suggest?: (word: string) => Awaitable<string[]>
}

type SpellBackendImpl = {
  name: string
  check: SpellBackendFn
  suggest: (word: string) => Awaitable<string[]>
}

type BackendOverride = {
  active: boolean
  backend: SpellBackendImpl | null
}

type EditorState = {
  backend: SpellBackendImpl | null
  timers: Map<string, ReturnType<typeof setTimeout>>
}

type BufferFlyspellState = {
  misspellings: FlyspellMisspelling[]
  lastText: string | null
  generation: number
}

type WordRange = {
  word: string
  start: number
  end: number
}

export const FLYSPELL_INCORRECT_FACE = "flyspell-incorrect" as FaceName
export const FLYSPELL_ACCEPT_LOCAL = "flyspell--accepted-words"

const FLYSPELL_STATE_LOCAL = "flyspell--state"
const WORD_RE = /[A-Za-z]+(?:'[A-Za-z]+)*/g
const editorStates = new WeakMap<Editor, EditorState>()
const backendOverride = defvar<BackendOverride>("flyspell--backend-override",
  { active: false, backend: null },
  "Test seam for overriding the spell checker backend.", "flyspell").value

export function setSpellBackend(backend: SpellBackend | SpellBackendFn | null | undefined): void {
  if (backend === undefined) {
    backendOverride.active = false
    backendOverride.backend = null
    return
  }
  backendOverride.active = true
  backendOverride.backend = backend === null ? null : normalizeBackend(backend)
}

function normalizeBackend(backend: SpellBackend | SpellBackendFn): SpellBackendImpl {
  if (typeof backend === "function") {
    return { name: "injected", check: backend, suggest: () => [] }
  }
  return {
    name: backend.name ?? "injected",
    check: backend.check,
    suggest: backend.suggest ?? (() => []),
  }
}

function stateFor(editor: Editor): EditorState {
  let state = editorStates.get(editor)
  if (!state) {
    state = { backend: null, timers: new Map() }
    editorStates.set(editor, state)
  }
  return state
}

function bufferState(buffer: BufferModel): BufferFlyspellState {
  let state = buffer.locals.get(FLYSPELL_STATE_LOCAL) as BufferFlyspellState | undefined
  if (!state) {
    state = { misspellings: [], lastText: null, generation: 0 }
    buffer.locals.set(FLYSPELL_STATE_LOCAL, state)
  }
  return state
}

export function flyspellMisspellings(buffer: BufferModel): FlyspellMisspelling[] {
  return [...bufferState(buffer).misspellings]
}

export function flyspellSpans(buffer: BufferModel): TextSpan[] {
  return bufferState(buffer).misspellings.map(misspelling => ({
    start: misspelling.start,
    end: misspelling.end,
    face: FLYSPELL_INCORRECT_FACE,
  }))
}

function acceptedWords(editor: Editor): Set<string> {
  let words = editor.locals.get(FLYSPELL_ACCEPT_LOCAL) as Set<string> | undefined
  if (!words) {
    words = new Set()
    editor.locals.set(FLYSPELL_ACCEPT_LOCAL, words)
  }
  return words
}

function wordKey(word: string): string {
  return word.toLowerCase()
}

function flyspellEnabled(editor: Editor, buffer: BufferModel): boolean {
  return editor.isMinorModeEnabled("flyspell-mode", buffer)
    || editor.isMinorModeEnabled("flyspell-prog-mode", buffer)
}

function detectExternalBackend(): SpellBackendImpl | null {
  const aspell = whichExecutable("aspell")
  if (aspell) return externalBackend("aspell", aspell)
  const hunspell = whichExecutable("hunspell")
  if (hunspell) return externalBackend("hunspell", hunspell)
  return null
}

function backendFor(editor: Editor): SpellBackendImpl | null {
  if (backendOverride.active) return backendOverride.backend
  return stateFor(editor).backend
}

function backendForCommand(editor: Editor): SpellBackendImpl | null {
  const backend = backendFor(editor)
  if (!backend) editor.message("no spell checker found")
  return backend
}

function externalBackend(name: "aspell" | "hunspell", command: string): SpellBackendImpl {
  return {
    name,
    async check(text: string): Promise<string[]> {
      const cmd = name === "aspell"
        ? [command, "list", "--mode=none"]
        : [command, "-l"]
      const out = await runSpellProcess(cmd, text)
      return out.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    },
    async suggest(word: string): Promise<string[]> {
      const cmd = name === "aspell"
        ? [command, "-a", "--mode=none"]
        : [command, "-a"]
      return parseIspellSuggestions(await runSpellProcess(cmd, `${word}\n`))
    },
  }
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
  out += decoder.decode()
  return out
}

async function runSpellProcess(cmd: string[], input: string): Promise<string> {
  const proc = spawnProcess({ cmd, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  proc.stdin?.write(input)
  proc.stdin?.end()
  const [stdout, stderr, code] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited,
  ])
  if (code !== 0 && !stdout.trim()) {
    const message = stderr.trim() || `${cmd[0]} exited with code ${code ?? "?"}`
    throw new Error(message)
  }
  return stdout
}

export function parseIspellSuggestions(output: string): string[] {
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("&")) continue
    const colon = line.indexOf(":")
    if (colon === -1) return []
    return unique(line.slice(colon + 1).split(",").map(s => s.trim()).filter(Boolean))
  }
  return []
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function scanWords(text: string): WordRange[] {
  const words: WordRange[] = []
  WORD_RE.lastIndex = 0
  for (;;) {
    const match = WORD_RE.exec(text)
    if (!match) break
    words.push({ word: match[0], start: match.index, end: match.index + match[0].length })
  }
  return words
}

function isMisspelling(value: unknown): value is SpellMisspelling {
  return typeof value === "object" && value !== null
    && "word" in value && typeof value.word === "string"
}

function normalizeMisspellings(
  text: string,
  raw: SpellBackendResult,
  accepted: Set<string>,
): FlyspellMisspelling[] {
  const positioned: FlyspellMisspelling[] = []
  const wordKeys = new Set<string>()
  const suggestions = new Map<string, string[]>()

  for (const item of raw) {
    if (typeof item === "string") {
      wordKeys.add(wordKey(item))
      continue
    }
    if (!isMisspelling(item)) continue
    const key = wordKey(item.word)
    wordKeys.add(key)
    if (item.suggestions?.length) suggestions.set(key, unique(item.suggestions))
    if (typeof item.start !== "number" || typeof item.end !== "number") continue
    const start = Math.max(0, Math.min(text.length, Math.trunc(item.start)))
    const end = Math.max(start, Math.min(text.length, Math.trunc(item.end)))
    if (end <= start || accepted.has(key)) continue
    positioned.push({ word: text.slice(start, end), start, end, suggestions: item.suggestions })
  }

  const covered = new Set(positioned.map(m => `${m.start}:${m.end}`))
  for (const word of scanWords(text)) {
    const key = wordKey(word.word)
    if (!wordKeys.has(key) || accepted.has(key)) continue
    const id = `${word.start}:${word.end}`
    if (covered.has(id)) continue
    positioned.push({ ...word, suggestions: suggestions.get(key) })
  }

  return positioned.sort((a, b) => a.start - b.start || a.end - b.end)
}

export async function flyspellCheckBuffer(
  editor: Editor,
  buffer: BufferModel = editor.currentBuffer,
  options: { force?: boolean; quiet?: boolean } = {},
): Promise<FlyspellMisspelling[]> {
  const state = bufferState(buffer)
  if (!options.force && state.lastText === buffer.text) return state.misspellings

  const backend = backendFor(editor)
  if (!backend) {
    state.misspellings = []
    state.lastText = buffer.text
    await editor.changed("flyspell")
    if (!options.quiet) editor.message("no spell checker found")
    return []
  }

  const text = buffer.text
  const generation = ++state.generation
  let raw: SpellBackendResult
  try {
    raw = await backend.check(text)
  } catch (err) {
    if (!options.quiet) editor.message(`Spell check failed: ${(err as Error).message}`)
    return state.misspellings
  }
  if (state.generation !== generation || buffer.text !== text) return state.misspellings

  state.misspellings = normalizeMisspellings(text, raw, acceptedWords(editor))
  state.lastText = text
  await editor.changed("flyspell")
  return state.misspellings
}

function clearBuffer(editor: Editor, buffer: BufferModel): void {
  const state = bufferState(buffer)
  state.misspellings = []
  state.lastText = null
  const timer = stateFor(editor).timers.get(buffer.id)
  if (timer) clearTimeout(timer)
  stateFor(editor).timers.delete(buffer.id)
  void editor.changed("flyspell-clear")
}

function scheduleCheck(editor: Editor, buffer: BufferModel, force = false): void {
  if (!editor.buffers.has(buffer.id) || !flyspellEnabled(editor, buffer)) return
  const state = stateFor(editor)
  const old = state.timers.get(buffer.id)
  if (old) clearTimeout(old)
  const seconds = getCustom<number>("flyspell-idle-delay") ?? 0.5
  const delay = Math.max(0, seconds * 1000)
  state.timers.set(buffer.id, setTimeout(() => {
    state.timers.delete(buffer.id)
    if (!editor.buffers.has(buffer.id) || !flyspellEnabled(editor, buffer)) return
    void flyspellCheckBuffer(editor, buffer, { force, quiet: true })
  }, delay))
}

function shouldSchedule(reason: string): boolean {
  if (reason.startsWith("flyspell")) return false
  if (reason.startsWith("message")) return false
  if (reason.startsWith("minibuffer")) return false
  if (reason.startsWith("read-key-sequence")) return false
  if (reason.startsWith("transient")) return false
  return true
}

function wordAtOrBeforePoint(buffer: BufferModel): WordRange | null {
  let previous: WordRange | null = null
  for (const word of scanWords(buffer.text)) {
    if (word.start <= buffer.point && buffer.point <= word.end) return word
    if (word.end <= buffer.point) previous = word
    if (word.start > buffer.point) break
  }
  return previous
}

function wordBeforePoint(buffer: BufferModel): WordRange | null {
  const point = Math.max(0, buffer.point - 1)
  let previous: WordRange | null = null
  for (const word of scanWords(buffer.text)) {
    if (word.start <= point && point < word.end) return word
    if (word.end <= buffer.point) previous = word
    if (word.start > buffer.point) break
  }
  return previous
}

async function wordIsMisspelled(editor: Editor, backend: SpellBackendImpl, word: string): Promise<boolean> {
  if (acceptedWords(editor).has(wordKey(word))) return false
  const misspellings = normalizeMisspellings(word, await backend.check(word), acceptedWords(editor))
  return misspellings.length > 0
}

type CorrectResult = "replaced" | "skipped" | "correct" | "quit"

async function correctWord(editor: Editor, buffer: BufferModel, bounds: WordRange): Promise<CorrectResult> {
  const backend = backendForCommand(editor)
  if (!backend) return "quit"
  const word = bounds.word
  const key = wordKey(word)
  if (acceptedWords(editor).has(key)) {
    editor.message(`${word} is accepted`)
    return "correct"
  }

  if (!(await wordIsMisspelled(editor, backend, word))) {
    editor.message(`${word} is correct`)
    return "correct"
  }

  const cached = bufferState(buffer).misspellings.find(m => m.start === bounds.start && m.end === bounds.end)
  let suggestions = cached?.suggestions ?? []
  if (!suggestions.length) {
    try {
      suggestions = unique(await backend.suggest(word))
    } catch {
      suggestions = []
    }
  }

  const replacement = await editor.completingRead(`Replace "${word}" with: `, {
    collection: suggestions,
    history: "ispell-word",
    initialValue: "",
  })
  if (replacement == null) return "quit"
  if (replacement === "") {
    acceptedWords(editor).add(key)
    await flyspellCheckBuffer(editor, buffer, { force: true, quiet: true })
    editor.message(`Accepted ${word}`)
    return "skipped"
  }

  buffer.replaceRange(bounds.start, bounds.end, replacement)
  await flyspellCheckBuffer(editor, buffer, { force: true, quiet: true })
  editor.message(`Replaced ${word} with ${replacement}`)
  return "replaced"
}

async function ispellBuffer(editor: Editor, buffer: BufferModel): Promise<void> {
  if (!backendForCommand(editor)) return
  await flyspellCheckBuffer(editor, buffer, { force: true })
  let start = buffer.pointMin
  for (;;) {
    const misspelling = bufferState(buffer).misspellings.find(m => m.start >= start)
    if (!misspelling) break
    buffer.point = misspelling.start
    await editor.changed("ispell-buffer")
    const result = await correctWord(editor, buffer, misspelling)
    if (result === "quit") return
    start = result === "replaced" ? buffer.point : misspelling.end
  }
  editor.message("Ispell buffer done")
}

function toggleBufferMinorMode(editor: Editor, buffer: BufferModel, mode: string, prefixArgument?: number | null): void {
  const enable = prefixArgument == null
    ? !editor.isMinorModeEnabled(mode, buffer)
    : prefixArgument > 0
  if (enable) {
    editor.enableMinorMode(mode, { buffer })
    if (!backendFor(editor)) editor.message("no spell checker found")
  } else {
    editor.disableMinorMode(mode, { buffer })
  }
}

function minorModeMap(name: string): Keymap {
  const keymap = new Keymap(`${name}-map`)
  keymap.bind("M-tab", "flyspell-correct-word-before-point")
  return keymap
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defcustom("flyspell-idle-delay", "number", 0.5,
    "Seconds of idle time before flyspell checks the current buffer.", "flyspell")
  defface("flyspell-incorrect", { underline: true, fg: "#ff6b6b" },
    "Face for misspelled words.", "flyspell")

  const state = stateFor(editor)
  state.backend = backendOverride.active ? backendOverride.backend : detectExternalBackend()

  const overlayEditors = defvar("flyspell--overlay-editors", new WeakSet<Editor>(),
    "Editors that have registered the flyspell overlay source.", "flyspell").value
  if (!overlayEditors.has(editor)) {
    editor.addOverlaySource(flyspellSpans)
    overlayEditors.add(editor)
  }

  ctx.minorMode({
    name: "flyspell-mode",
    lighter: " Fly",
    keymap: minorModeMap("flyspell-mode"),
    onEnable: (ed, buffer) => { if (buffer) scheduleCheck(ed, buffer, true) },
    onDisable: (ed, buffer) => { if (buffer && !flyspellEnabled(ed, buffer)) clearBuffer(ed, buffer) },
  })
  ctx.minorMode({
    name: "flyspell-prog-mode",
    lighter: " Fly",
    keymap: minorModeMap("flyspell-prog-mode"),
    onEnable: (ed, buffer) => { if (buffer) scheduleCheck(ed, buffer, true) },
    onDisable: (ed, buffer) => { if (buffer && !flyspellEnabled(ed, buffer)) clearBuffer(ed, buffer) },
  })

  ctx.command("flyspell-mode", ({ editor, buffer, prefixArgument }) => {
    toggleBufferMinorMode(editor, buffer, "flyspell-mode", prefixArgument)
  }, "Toggle on-the-fly spell checking in the current buffer.")
  ctx.command("flyspell-prog-mode", ({ editor, buffer, prefixArgument }) => {
    toggleBufferMinorMode(editor, buffer, "flyspell-prog-mode", prefixArgument)
  }, "Toggle on-the-fly spell checking for programming buffers.")
  ctx.command("ispell-word", async ({ editor, buffer }) => {
    const word = wordAtOrBeforePoint(buffer)
    if (!word) {
      editor.message("No word at point")
      return
    }
    await correctWord(editor, buffer, word)
  }, "Check and correct the word at point.")
  ctx.command("ispell-buffer", async ({ editor, buffer }) => {
    await ispellBuffer(editor, buffer)
  }, "Interactively spell-check the current buffer.")
  ctx.command("flyspell-correct-word-before-point", async ({ editor, buffer }) => {
    const word = wordBeforePoint(buffer)
    if (!word) {
      editor.message("No word before point")
      return
    }
    await correctWord(editor, buffer, word)
  }, "Correct the misspelled word before point.")

  ctx.key("global-map", "M-$", "ispell-word")

  const offChanged = editor.events.on("changed", ({ reason }) => {
    if (!shouldSchedule(reason)) return
    const buffer = editor.currentBuffer
    if (flyspellEnabled(editor, buffer)) scheduleCheck(editor, buffer)
  })
  ctx.onDispose(() => {
    offChanged()
    for (const timer of state.timers.values()) clearTimeout(timer)
    state.timers.clear()
  })
}
