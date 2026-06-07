import type { Editor, CompletingReadFunction, MinibufferCompletionFrontend } from "../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../src/runtime/plugin-context"
import { BufferModel } from "../src/kernel/buffer"
import { fileCompletionCandidates, splitCompletionInput } from "../src/kernel/completion"
import { defcustom, defvar, getCustom } from "../src/runtime/custom"

type VerticoState = {
  candidates: string[]
  index: number
  scroll: number
  groups: string[]
  displayCandidates: string[]
  exitInput: boolean
  input: VerticoInput | null
}

type VerticoInput = {
  text: string
  point: number
}

const states = new WeakMap<Editor, VerticoState>()
const installedEditors = new WeakSet<Editor>()

const verticoCompletingRead: CompletingReadFunction = async (editor, prompt, options) => {
  const promise = editor.prompt(prompt, options.initialValue ?? "", options.history, {
    collection: options.collection,
    completion: options.completion,
    defaultDirectory: options.defaultDirectory,
  })
  await verticoRefresh(editor)
  return await promise
}

const verticoFrontend: MinibufferCompletionFrontend = {
  refresh: editor => verticoRefresh(editor),
  complete: editor => verticoInsert(editor),
  submitValue: editor => verticoSubmitValue(editor),
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  installCustomVariables()

  ctx.minorMode({
    name: "vertico-mode",
    lighter: " Vertico",
    global: true,
    onEnable: editor => {
      editor.pushCompletingReadFunction(verticoCompletingRead)
      editor.pushMinibufferCompletionFrontend(verticoFrontend)
    },
    onDisable: editor => {
      editor.popCompletingReadFunction(verticoCompletingRead)
      editor.popMinibufferCompletionFrontend(verticoFrontend)
      states.delete(editor)
    },
  })

  if (installedEditors.has(editor)) return
  installedEditors.add(editor)

  ctx.hook("post-command-hook", async ({ editor: ed }) => {
    if (!ed.minibuffer || !ed.isMinorModeEnabled("vertico-mode") || !isCompletionPrompt(ed)) return
    const state = states.get(ed)
    if (!sameInput(state?.input ?? null, currentInput(ed))) await verticoRefresh(ed)
  })

  editor.command("vertico-mode", ({ editor, prefixArgument }) => {
    if (prefixArgument === 1) editor.enableMinorMode("vertico-mode")
    else if (prefixArgument === 0 || prefixArgument === -1) editor.disableMinorMode("vertico-mode")
    else editor.toggleMinorMode("vertico-mode")
  }, "Toggle Vertico completion mode.")

  editor.command("vertico-first", ({ editor }) => verticoGoto(editor, firstCandidateIndex(editor)), "Go to the first Vertico candidate.")
  editor.command("vertico-last", ({ editor }) => verticoGoto(editor, lastCandidateIndex(editor)), "Go to the last Vertico candidate.")
  editor.command("vertico-next", ({ editor, prefixArgument }) => verticoNext(editor, prefixArgument ?? 1), "Go to the next Vertico candidate.")
  editor.command("vertico-previous", ({ editor, prefixArgument }) => verticoNext(editor, -(prefixArgument ?? 1)), "Go to the previous Vertico candidate.")
  editor.command("vertico-scroll-up", ({ editor, prefixArgument }) => verticoNext(editor, (prefixArgument ?? 1) * verticoCount()), "Scroll Vertico candidates up.")
  editor.command("vertico-scroll-down", ({ editor, prefixArgument }) => verticoNext(editor, -(prefixArgument ?? 1) * verticoCount()), "Scroll Vertico candidates down.")
  editor.command("vertico-next-group", ({ editor, prefixArgument }) => verticoGroup(editor, prefixArgument ?? 1), "Go to the next Vertico candidate group.")
  editor.command("vertico-previous-group", ({ editor, prefixArgument }) => verticoGroup(editor, -(prefixArgument ?? 1)), "Go to the previous Vertico candidate group.")
  editor.command("vertico-exit", ({ editor }) => editor.minibufferSubmit(), "Exit the minibuffer with the current Vertico candidate.")
  editor.command("vertico-exit-input", ({ editor }) => {
    const state = ensureState(editor)
    state.exitInput = true
    editor.minibufferSubmit()
  }, "Exit the minibuffer with the current input.")
  editor.command("vertico-save", ({ editor }) => verticoSave(editor), "Save the current Vertico candidates to a buffer.")
  editor.command("vertico-insert", ({ editor }) => verticoInsert(editor), "Insert the current Vertico candidate in the minibuffer.")

  editor.defineKey("minibuffer", "up", "vertico-previous")
  editor.defineKey("minibuffer", "down", "vertico-next")
  editor.defineKey("minibuffer", "C-p", "vertico-previous")
  editor.defineKey("minibuffer", "C-n", "vertico-next")
  editor.defineKey("minibuffer", "M-<", "vertico-first")
  editor.defineKey("minibuffer", "M->", "vertico-last")
  editor.defineKey("minibuffer", "C-v", "vertico-scroll-up")
  editor.defineKey("minibuffer", "M-v", "vertico-scroll-down")
  editor.defineKey("minibuffer", "M-n", "vertico-next-group")
  editor.defineKey("minibuffer", "M-p", "vertico-previous-group")
  editor.defineKey("minibuffer", "M-w", "vertico-save")
  editor.defineKey("minibuffer", "M-RET", "vertico-exit-input")
  editor.defineKey("minibuffer", "M-enter", "vertico-exit-input")
  editor.defineKey("minibuffer", "tab", "vertico-insert")
  editor.defineKey("minibuffer", "C-i", "vertico-insert")
}

function installCustomVariables(): void {
  defvar("vertico-count-format", ["%-6s ", "%s/%s"], "Format string used for the candidate count.")
  defvar("vertico-group-format", "    %s ", "Format string used for the group title.")
  defcustom("vertico-count", "number", 10, "Maximal number of candidates to show.")
  defvar("vertico-preselect", "directory", "Configure if the prompt or first candidate is preselected.")
  defcustom("vertico-scroll-margin", "number", 2, "Number of lines at the top and bottom when scrolling.")
  defvar("vertico-resize", true, "How to resize the Vertico minibuffer window.")
  defcustom("vertico-cycle", "boolean", false, "Enable cycling for `vertico-next' and `vertico-previous'.")
  defvar("vertico-multiline", ["<NL>", "..."], "Replacements for multiline strings.")
  defvar("vertico-sort-function", "vertico-sort-history-length-alpha", "Default sorting function.")
  defvar("vertico-sort-override-function", null, "Override sort function.")
}

async function verticoRefresh(editor: Editor): Promise<void> {
  const request = editor.minibuffer
  if (!request || !editor.isMinorModeEnabled("vertico-mode")) return
  if (!isCompletionPrompt(editor)) {
    states.delete(editor)
    editor.minibufferCompletionDisplay = null
    return
  }
  const inputState = currentInput(editor)
  const input = inputState.text
  const fileCompletion = request.completion === "file"
  const candidates = request.completion === "file"
    ? await fileCompletionCandidates(input, request.fileCompletionDirectory ?? process.cwd())
    : request.collection ?? []
  if (editor.minibuffer !== request || !sameInput(inputState, currentInput(editor))) return
  const state = ensureState(editor)
  state.candidates = sortCandidates(filterCandidates(editor, candidates, input, fileCompletion))
  state.displayCandidates = state.candidates.map(candidate => displayCandidate(candidate, input, fileCompletion))
  state.groups = state.candidates.map(candidate => candidateGroup(candidate, fileCompletion))
  state.exitInput = false
  state.input = inputState
  const preselectPrompt = shouldPreselectPrompt(editor, input, fileCompletion)
  if (state.candidates.length === 0) state.index = promptAllowed(editor) ? -1 : 0
  else if (preselectPrompt) state.index = -1
  else if (state.index < 0 || !promptAllowed(editor)) state.index = 0
  else if (state.index >= state.candidates.length) state.index = state.candidates.length - 1
  computeScroll(state)
  showVerticoCompletions(editor, state)
}

async function verticoNext(editor: Editor, delta: number): Promise<void> {
  if (!editor.minibuffer || !editor.isMinorModeEnabled("vertico-mode") || !isCompletionPrompt(editor)) {
    if (delta < 0) await editor.minibufferPreviousHistory()
    else await editor.minibufferNextHistory()
    return
  }
  let state = states.get(editor)
  if (!state) {
    await verticoRefresh(editor)
    state = states.get(editor)
  }
  if (!state) return
  if (!state.candidates.length) {
    await verticoRefresh(editor)
    return
  }
  verticoGoto(editor, state.index + delta)
}

function verticoGoto(editor: Editor, index: number): void {
  const state = states.get(editor)
  if (!state || !editor.minibuffer || !editor.isMinorModeEnabled("vertico-mode") || !isCompletionPrompt(editor)) return
  const min = promptAllowed(editor) ? -1 : 0
  const max = Math.max(min, state.candidates.length - 1)
  const cycle = getCustom<boolean>("vertico-cycle") ?? false
  if (cycle && state.candidates.length) {
    const size = max - min + 1
    state.index = ((index - min) % size + size) % size + min
  } else {
    state.index = Math.max(min, Math.min(max, index))
  }
  computeScroll(state)
  showVerticoCompletions(editor, state)
}

function verticoGroup(editor: Editor, delta: number): void {
  const state = states.get(editor)
  if (!state?.candidates.length) return
  const direction = delta < 0 ? -1 : 1
  let index = Math.max(0, state.index)
  for (let remaining = Math.abs(delta); remaining > 0; remaining--) {
    const current = state.groups[index]
    do {
      index += direction
      if (index < 0 || index >= state.candidates.length) {
        index = direction < 0 ? 0 : state.candidates.length - 1
        break
      }
    } while (state.groups[index] === current)
  }
  verticoGoto(editor, index)
}

async function verticoInsert(editor: Editor): Promise<void> {
  if (!editor.minibuffer || !editor.isMinorModeEnabled("vertico-mode") || !isCompletionPrompt(editor)) {
    await editor.minibufferComplete()
    return
  }
  let state = states.get(editor)
  if (!state) {
    await verticoRefresh(editor)
    state = states.get(editor)
  }
  if (!state) return
  await verticoRefresh(editor)
  const candidate = verticoCandidate(editor)
  if (candidate == null) return
  editor.activeBuffer.setText(candidate, true)
  editor.activeBuffer.point = candidate.length
  await verticoRefresh(editor)
  await editor.changed("vertico-insert")
}

function verticoSubmitValue(editor: Editor): string | undefined {
  const state = states.get(editor)
  if (!state || !editor.isMinorModeEnabled("vertico-mode") || !isCompletionPrompt(editor)) return undefined
  if (state.exitInput) return editor.activeBuffer.text
  return verticoCandidate(editor)
}

function verticoCandidate(editor: Editor): string | undefined {
  const state = states.get(editor)
  if (!state || state.index < 0) return editor.activeBuffer.text
  return state.candidates[state.index]
}

function isCompletionPrompt(editor: Editor): boolean {
  const request = editor.minibuffer
  return !!(request?.completion === "file" || request?.collection?.length)
}

function verticoSave(editor: Editor): void {
  const state = states.get(editor)
  if (!state) return
  const body = state.candidates.join("\n")
  const existing = [...editor.buffers.values()].find(b => b.name === "*Vertico Completions*")
  if (existing) existing.setText(body, false)
  else editor.addBuffer(new BufferModel({ name: "*Vertico Completions*", text: body, kind: "scratch", mode: "text" }))
  void editor.changed("vertico-save")
}

function showVerticoCompletions(editor: Editor, state: VerticoState): void {
  const count = verticoCount()
  const visible = state.displayCandidates.slice(state.scroll, state.scroll + count)
  const countText = formatCount(state)
  const lines = visible.map((candidate, offset) => {
    const index = state.scroll + offset
    const marker = index === state.index ? "> " : "  "
    return `${marker}${displayCandidate(candidate)}`
  })
  const body = [countText, ...lines].filter(Boolean).join("\n")
  editor.minibufferCompletionDisplay = {
    text: body,
    selectedLine: state.index >= state.scroll ? state.index - state.scroll + (countText ? 1 : 0) : undefined,
  }
  void editor.changed("vertico-exhibit")
}

function ensureState(editor: Editor): VerticoState {
  let state = states.get(editor)
  if (!state) {
    state = { candidates: [], index: firstCandidateIndex(editor), scroll: 0, groups: [], displayCandidates: [], exitInput: false, input: null }
    states.set(editor, state)
  }
  return state
}

function currentInput(editor: Editor): VerticoInput {
  const text = editor.minibufferInput()
  return { text, point: Math.min(editor.activeBuffer.point, text.length) }
}

function sameInput(a: VerticoInput | null, b: VerticoInput): boolean {
  return !!a && a.text === b.text && a.point === b.point
}

function filterCandidates(editor: Editor, candidates: string[], input: string, fileCompletion: boolean): string[] {
  if (fileCompletion) return candidates
  // Honour the active completion-style (fido/orderless set editor.completer); the
  // kernel's own path is short-circuited by our frontend.refresh so we must consult it here.
  if (editor.completer) return editor.completer(input, candidates)
  const needle = input.trim().toLowerCase()
  if (!needle) return candidates
  return candidates.filter(candidate => candidate.toLowerCase().startsWith(needle))
}

function sortCandidates(candidates: string[]): string[] {
  const sorter = getCustom<unknown>("vertico-sort-override-function") ?? getCustom<unknown>("vertico-sort-function")
  if (sorter === null || sorter === false) return candidates
  return [...candidates].sort((a, b) => a.length - b.length || a.localeCompare(b))
}

function displayCandidate(candidate: string, input = "", fileCompletion = false): string {
  const multiline = getCustom<[string, string]>("vertico-multiline") ?? ["<NL>", "..."]
  const display = fileCompletion ? fileDisplayCandidate(candidate, input) : candidate
  return display.replace(/\n/g, multiline[0] ?? "<NL>")
}

function formatCount(state: VerticoState): string {
  const format = getCustom<[string, string] | null>("vertico-count-format")
  if (format == null) return ""
  const current = state.index >= 0 ? String(state.index + 1) : "*"
  return `${current}/${state.candidates.length}`
}

function computeScroll(state: VerticoState): void {
  const count = verticoCount()
  const margin = Math.max(0, Math.min(getCustom<number>("vertico-scroll-margin") ?? 2, Math.floor(count / 2)))
  if (state.index < 0) {
    state.scroll = 0
    return
  }
  if (state.index < state.scroll + margin) {
    state.scroll = Math.max(0, state.index - margin)
  } else if (state.index >= state.scroll + count - margin) {
    state.scroll = Math.max(0, state.index - count + margin + 1)
  }
}

function verticoCount(): number {
  return Math.max(1, Math.floor(getCustom<number>("vertico-count") ?? 10))
}

function promptAllowed(editor: Editor): boolean {
  return getCustom<string>("vertico-preselect") !== "no-prompt"
}

function shouldPreselectPrompt(editor: Editor, input: string, fileCompletion: boolean): boolean {
  const preselect = getCustom<string>("vertico-preselect") ?? "directory"
  return preselect === "prompt" || (preselect === "directory" && fileCompletion && /\/$/.test(input || editor.activeBuffer.text))
}

function firstCandidateIndex(editor: Editor): number {
  return shouldPreselectPrompt(editor, editor.activeBuffer.text, editor.minibuffer?.completion === "file") ? -1 : 0
}

function lastCandidateIndex(editor: Editor): number {
  const state = states.get(editor)
  return Math.max(firstCandidateIndex(editor), (state?.candidates.length ?? 1) - 1)
}

function candidateGroup(candidate: string, fileCompletion: boolean): string {
  if (!fileCompletion) return ""
  const slash = candidate.lastIndexOf("/", candidate.endsWith("/") ? candidate.length - 2 : candidate.length - 1)
  return slash >= 0 ? candidate.slice(0, slash + 1) : ""
}

function fileDisplayCandidate(candidate: string, input: string): string {
  const rawBase = input.endsWith("/")
    ? input
    : splitCompletionInput(input).directory
  const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`
  if (candidate.startsWith(base)) return candidate.slice(base.length)
  return candidate.split("/").filter(Boolean).at(-1) ?? candidate
}
