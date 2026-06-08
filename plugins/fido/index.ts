import type { Editor, Completer } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defcustom, getCustom } from "../../src/runtime/custom"

type FidoState = {
  candidates: string[]
  selected: number
}

defcustom("icomplete-prospects-height", "number", 10, "Max vertical candidates shown by fido-vertical-mode.")

const WORD_CHAR = /[a-z0-9]/i

/** Subsequence (flex) match. `score` is matchLen/candidateLen; `runs` counts contiguous match
 * segments; `anchored` is true when the first matched char sits at a word boundary. */
export function flexMatch(pattern: string, candidate: string): { score: number; runs: number; anchored: boolean } | null {
  if (!pattern) return { score: 1, runs: 0, anchored: true }
  const pat = pattern.toLowerCase()
  const cand = candidate.toLowerCase()
  let ci = 0
  let runs = 0
  let prev = -2
  let first = -1
  for (const ch of pat) {
    const found = cand.indexOf(ch, ci)
    if (found === -1) return null
    if (first < 0) first = found
    if (found !== prev + 1) runs++
    prev = found
    ci = found + 1
  }
  const anchored = first === 0 || !WORD_CHAR.test(cand[first - 1]!)
  return { score: pattern.length / candidate.length, runs, anchored }
}

export function flexScore(pattern: string, candidate: string): number | null {
  return flexMatch(pattern, candidate)?.score ?? null
}

export const flexCompleter: Completer = (input, collection) => {
  const scored: Array<{ text: string; score: number; runs: number; anchored: boolean }> = []
  for (const item of collection) {
    const m = flexMatch(input, item)
    if (m) scored.push({ text: item, ...m })
  }
  // Anchored matches first, then fewest runs (heavily penalises scattered subsequence
  // hits like grep→do[g]food-[rep]ort), then the length-ratio score.
  scored.sort((a, b) =>
    Number(b.anchored) - Number(a.anchored)
    || a.runs - b.runs
    || b.score - a.score
    || a.text.length - b.text.length
    || a.text.localeCompare(b.text),
  )
  return scored.map(s => s.text)
}

/** Fido owns the minibuffer only when its mode is on AND no other frontend (vertico, ivy)
 * has claimed `minibufferCompletionFrontend`. Keys are bound at install() so handlers must
 * check this themselves and fall through to default behaviour otherwise (t-fa555091). */
function fidoActive(editor: Editor): boolean {
  return editor.globalMinorModes.has("fido-vertical-mode") && !editor.minibufferCompletionFrontend
}

function fidoState(editor: Editor): FidoState {
  const buffer = editor.activeBuffer
  let state = buffer.locals.get("fido") as FidoState | undefined
  if (!state) {
    state = { candidates: [], selected: 0 }
    buffer.locals.set("fido", state)
  }
  return state
}

function renderOverlay(state: FidoState): string {
  const max = getCustom<number>("icomplete-prospects-height") ?? 10
  if (!state.candidates.length) return " [No match]"
  return state.candidates
    .slice(0, max)
    .map((c, i) => (i === state.selected ? "► " : "  ") + c)
    .join("\n")
}

async function fidoExhibit(editor: Editor): Promise<void> {
  if (!editor.minibuffer) return
  const state = fidoState(editor)
  const input = editor.minibufferInput()
  const collection = await editor.minibufferCollection()
  state.candidates = collection.length ? flexCompleter(input, collection) : []
  if (state.selected >= state.candidates.length) state.selected = 0
  editor.setMinibufferOverlay(collection.length ? renderOverlay(state) : "")
}

function fidoMove(editor: Editor, delta: number): void {
  if (!editor.minibuffer || !fidoActive(editor)) return
  const state = fidoState(editor)
  const n = state.candidates.length
  if (!n) return
  state.selected = ((state.selected + delta) % n + n) % n
  editor.setMinibufferOverlay(renderOverlay(state))
}

async function fidoDescend(editor: Editor, dir: string): Promise<void> {
  editor.activeBuffer.setText(dir, false)
  editor.activeBuffer.point = dir.length
  fidoState(editor).selected = 0
  await fidoExhibit(editor)
}

async function fidoRet(editor: Editor): Promise<void> {
  if (!editor.minibuffer) return
  if (!fidoActive(editor)) {
    editor.minibufferSubmit()
    return
  }
  const state = fidoState(editor)
  const choice = state.candidates[state.selected]
  if (choice == null) {
    const completing = editor.minibuffer.completion === "file" || (editor.minibuffer.collection?.length ?? 0) > 0
    if (completing) {
      editor.message("[No match]")
      return
    }
    editor.minibufferSubmit()
    return
  }
  if (editor.minibuffer.completion === "file" && choice.endsWith("/")) {
    await fidoDescend(editor, choice)
    return
  }
  editor.minibufferAccept(choice)
}

async function fidoSlash(editor: Editor): Promise<void> {
  if (!fidoActive(editor)) {
    await editor.run("self-insert-command", ["/"])
    return
  }
  const state = fidoState(editor)
  const choice = state.candidates[state.selected]
  if (editor.minibuffer?.completion === "file" && choice?.endsWith("/")) {
    await fidoDescend(editor, choice)
    return
  }
  await editor.run("self-insert-command", ["/"])
}

async function fidoBackwardUpdir(editor: Editor): Promise<void> {
  if (!editor.minibuffer) return
  if (!fidoActive(editor)) {
    await editor.run("delete-backward-char")
    return
  }
  const buffer = editor.activeBuffer
  const input = editor.minibufferInput()
  const isFile = editor.minibuffer.completion === "file"
  if (isFile && buffer.point > 0 && input[buffer.point - 1] === "/") {
    const prev = input.lastIndexOf("/", buffer.point - 2)
    const cut = prev === -1 ? 0 : prev + 1
    buffer.setText(input.slice(0, cut), false)
    buffer.point = cut
  } else {
    buffer.deleteBackward()
  }
  fidoState(editor).selected = 0
  await fidoExhibit(editor)
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  ctx.minorMode({
    name: "fido-vertical-mode",
    lighter: " Fido",
    global: true,
    onEnable: ed => { ed.completer = flexCompleter },
    onDisable: ed => { if (ed.completer === flexCompleter) ed.completer = null },
  })

  editor.command("fido-vertical-mode", ({ editor }) => {
    editor.toggleMinorMode("fido-vertical-mode")
  }, "Toggle flex-matching vertical minibuffer completion.")

  editor.command("icomplete-forward-completions", ({ editor }) => fidoMove(editor, 1),
    "Select the next vertical completion candidate.")
  editor.command("icomplete-backward-completions", ({ editor }) => fidoMove(editor, -1),
    "Select the previous vertical completion candidate.")
  editor.command("icomplete-fido-ret", ({ editor }) => fidoRet(editor),
    "Accept the selected candidate, descending into directories for file completion.")
  editor.command("icomplete-fido-backward-updir", ({ editor }) => fidoBackwardUpdir(editor),
    "Delete a char, or with point after `/` delete back to the parent directory.")
  editor.command("icomplete-fido-exit", ({ editor }) => editor.minibufferSubmit(),
    "Exit the minibuffer with the literal input, ignoring the selected candidate.")
  editor.command("icomplete-fido-slash", ({ editor }) => fidoSlash(editor),
    "Descend into the highlighted directory during file completion; otherwise insert `/`.")

  // Fallbacks so fido-only installs still let M-x grep / M-x rgrep exact-match.
  // In normal startup next-error registers the real grep commands before fido.
  if (!editor.commands.get("grep")) {
    editor.command("grep", ({ editor, args }) => editor.run("counsel-ag", args),
      "Fallback alias for counsel-ag when grep is not installed.")
  }
  if (!editor.commands.get("rgrep")) {
    editor.command("rgrep", ({ editor, args }) => editor.run("counsel-ag", args),
      "Fallback alias for counsel-ag when rgrep is not installed.")
  }

  editor.defineKey("minibuffer", "C-n", "icomplete-forward-completions")
  editor.defineKey("minibuffer", "C-p", "icomplete-backward-completions")
  editor.defineKey("minibuffer", "down", "icomplete-forward-completions")
  editor.defineKey("minibuffer", "up", "icomplete-backward-completions")
  editor.defineKey("minibuffer", "C-s", "icomplete-forward-completions")
  editor.defineKey("minibuffer", "C-r", "icomplete-backward-completions")
  editor.defineKey("minibuffer", "return", "icomplete-fido-ret")
  editor.defineKey("minibuffer", "enter", "icomplete-fido-ret")
  editor.defineKey("minibuffer", "C-m", "icomplete-fido-ret")
  editor.defineKey("minibuffer", "backspace", "icomplete-fido-backward-updir")
  editor.defineKey("minibuffer", "M-j", "icomplete-fido-exit")
  editor.defineKey("minibuffer", "C-j", "icomplete-fido-exit")
  editor.defineKey("minibuffer", "/", "icomplete-fido-slash")

  editor.events.on("minibuffer", async () => {
    if (!fidoActive(editor)) return
    await fidoExhibit(editor)
  })
  editor.events.on("changed", async ({ reason }) => {
    if (!editor.minibuffer) return
    if (!fidoActive(editor)) return
    if (!reason.startsWith("command:") || reason.startsWith("command:icomplete-")) return
    await fidoExhibit(editor)
  })

  editor.enableMinorMode("fido-vertical-mode")
}
