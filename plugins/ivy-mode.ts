import type { Editor, CompletingReadFunction, MinibufferCompletionFrontend } from "../src/kernel/editor"
import { BufferModel } from "../src/kernel/buffer"
import { fileCompletionCandidates } from "../src/kernel/completion"
import { defineMinorMode } from "../src/modes/minor-mode"

type IvyState = {
  matches: string[]
  index: number
  previousFrontend: MinibufferCompletionFrontend | null
}

const ivyStates = new WeakMap<Editor, IvyState>()
const installedEditors = new WeakSet<Editor>()
const previousCompletingReadFunctions = new WeakMap<Editor, CompletingReadFunction | null>()

const ivyCompletingRead: CompletingReadFunction = async (editor, prompt, options) => {
  const previousFrontend = editor.minibufferCompletionFrontend
  const state: IvyState = { matches: [], index: 0, previousFrontend }
  ivyStates.set(editor, state)
  editor.minibufferCompletionFrontend = ivyFrontend
  const promise = editor.prompt(prompt, options.initialValue ?? "", options.history, {
    collection: options.collection,
    completion: options.completion,
    defaultDirectory: options.defaultDirectory,
  })
  await ivyRefresh(editor)
  try {
    return await promise
  } finally {
    editor.minibufferCompletionFrontend = previousFrontend
    ivyStates.delete(editor)
  }
}

const ivyFrontend: MinibufferCompletionFrontend = {
  refresh: editor => ivyRefresh(editor),
  complete: editor => ivyPartialOrDone(editor),
  submitValue: editor => ivyCurrentCandidate(editor),
}

export function install(editor: Editor): void {
  defineMinorMode({
    name: "ivy-mode",
    lighter: " Ivy",
    global: true,
    onEnable: editor => {
      if (!previousCompletingReadFunctions.has(editor)) {
        previousCompletingReadFunctions.set(editor, editor.completingReadFunction)
      }
      editor.completingReadFunction = ivyCompletingRead
    },
    onDisable: editor => {
      if (editor.completingReadFunction === ivyCompletingRead) {
        editor.completingReadFunction = previousCompletingReadFunctions.get(editor) ?? null
      }
      previousCompletingReadFunctions.delete(editor)
    },
  })

  if (installedEditors.has(editor)) return
  installedEditors.add(editor)

  editor.command("ivy-mode", ({ editor, prefixArgument }) => {
    if (prefixArgument === 1) editor.enableMinorMode("ivy-mode")
    else if (prefixArgument === 0 || prefixArgument === -1) editor.disableMinorMode("ivy-mode")
    else editor.toggleMinorMode("ivy-mode")
  }, "Toggle Ivy completion mode.")

  editor.command("ivy-next-line", ({ editor }) => ivyNextLine(editor), "Move to the next Ivy completion candidate.")
  editor.command("ivy-previous-line", ({ editor }) => ivyNextLine(editor, -1), "Move to the previous Ivy completion candidate.")

  editor.defineKey("minibuffer", "up", "ivy-previous-line")
  editor.defineKey("minibuffer", "down", "ivy-next-line")
  editor.defineKey("minibuffer", "C-p", "ivy-previous-line")
  editor.defineKey("minibuffer", "C-n", "ivy-next-line")
}

async function ivyNextLine(editor: Editor, delta = 1): Promise<void> {
  const state = ivyStates.get(editor)
  if (!state) {
    if (delta < 0) await editor.minibufferPreviousHistory()
    else await editor.minibufferNextHistory()
    return
  }
  if (!state.matches.length) {
    await ivyRefresh(editor)
    return
  }
  state.index = (state.index + delta + state.matches.length) % state.matches.length
  showIvyCompletions(editor, state.matches, state.index)
}

async function ivyPartialOrDone(editor: Editor): Promise<void> {
  await ivyRefresh(editor)
  const selected = ivyCurrentCandidate(editor)
  if (!selected) return
  const buffer = editor.activeBuffer
  buffer.setText(selected, true)
  buffer.point = selected.length
  await editor.changed("ivy-complete")
}

async function ivyRefresh(editor: Editor): Promise<void> {
  const request = editor.minibuffer
  const state = ivyStates.get(editor)
  if (!request || !state) return
  const input = editor.activeBuffer.text
  const candidates = request.completion === "file"
    ? await fileCompletionCandidates(input, request.fileCompletionDirectory ?? process.cwd())
    : request.collection ?? []
  state.matches = ivyFilterCandidates(candidates, input, request.completion === "file")
  state.index = Math.min(state.index, Math.max(0, state.matches.length - 1))
  showIvyCompletions(editor, state.matches, state.index)
}

function ivyCurrentCandidate(editor: Editor): string | undefined {
  const state = ivyStates.get(editor)
  return state?.matches[state.index]
}

function showIvyCompletions(editor: Editor, matches: string[], selectedIndex: number): void {
  const existing = [...editor.buffers.values()].find(b => b.name === "*ivy-completions*")
  const body = matches.slice(0, 12).map((match, index) => `${index === selectedIndex ? "> " : "  "}${match}`).join("\n")
  if (existing) existing.setText(body, false)
  else editor.addBuffer(new BufferModel({ name: "*ivy-completions*", text: body, kind: "scratch", mode: "text" }))
  void editor.changed("ivy-complete")
}

function ivyFilterCandidates(candidates: string[], input: string, fileCompletion: boolean): string[] {
  if (fileCompletion) return candidates
  const needle = input.trim().toLowerCase()
  if (!needle) return candidates
  return candidates.filter(candidate => candidate.toLowerCase().includes(needle))
}
