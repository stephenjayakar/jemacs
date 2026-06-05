import type { Editor } from "../../src/kernel/editor"
import { BufferModel } from "../../src/kernel/buffer"
import type { LspWorkspace } from "../../src/lsp/workspace"
import { defineMode, enterMode, type TextSpan } from "../../src/modes/mode"
import { addHook } from "../../src/kernel/hooks"
import { defineMinorMode } from "../../src/modes/minor-mode"
import { Keymap } from "../../src/kernel/keymap"
import { lspMakeTextDocumentIdentifier } from "../../src/lsp/lsp-protocol"
import { pointToPosition } from "../../src/lsp/positions"
import { registerLeanClient } from "../../src/lsp/clients/lean"

export const LEAN_INFO_BUFFER = "*lean-info*"
export const LEAN_GOAL_DEBOUNCE_MS = 200
export const LEAN_NO_SERVER_MSG = "Lean server not connected (install lake or lean)"

/** Shape of the Lean server's `$/lean/plainGoal` extension response. */
export type PlainGoalResult = {
  rendered?: string
  goals: string[]
}

export const LEAN_KEYWORDS = new Set(
  "def theorem lemma axiom instance structure inductive by exact fun match with where let have show".split(" "),
)

const DECL_KEYWORDS = "def|theorem|lemma|axiom|instance|structure|inductive"

export function leanFontLock(buffer: BufferModel): TextSpan[] {
  const spans: TextSpan[] = []
  const text = buffer.text
  for (const m of text.matchAll(/--[^\n]*/g)) {
    spans.push({ start: m.index!, end: m.index! + m[0].length, face: "comment" })
  }
  for (const m of text.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    if (!covered(spans, m.index!)) spans.push({ start: m.index!, end: m.index! + m[0].length, face: "string" })
  }
  for (const m of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_']*\b/g)) {
    const start = m.index!
    if (LEAN_KEYWORDS.has(m[0]) && !covered(spans, start)) {
      spans.push({ start, end: start + m[0].length, face: "keyword" })
    }
  }
  const declRe = new RegExp(`\\b(?:${DECL_KEYWORDS})\\s+([A-Za-z_][A-Za-z0-9_'.]*)`, "g")
  for (const m of text.matchAll(declRe)) {
    const name = m[1]!
    const start = m.index! + m[0].lastIndexOf(name)
    if (!covered(spans, start, "comment")) spans.push({ start, end: start + name.length, face: "function" })
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

function covered(spans: TextSpan[], at: number, face?: TextSpan["face"]): boolean {
  return spans.some(s => at >= s.start && at < s.end && (!face || s.face === face))
}

function activeWorkspaces(editor: Editor, buffer: BufferModel): LspWorkspace[] {
  return editor.lsp?.bufferWorkspaces(buffer).filter(w => w.status === "initialized") ?? []
}

export async function requestPlainGoal(editor: Editor, buffer: BufferModel): Promise<PlainGoalResult | null> {
  for (const ws of activeWorkspaces(editor, buffer)) {
    const params = {
      textDocument: lspMakeTextDocumentIdentifier({ uri: ws.uriForBuffer(buffer) }),
      position: pointToPosition(buffer.text, buffer.point),
    }
    try {
      const result = await ws.rpc.request("$/lean/plainGoal", params) as PlainGoalResult | null
      if (result) return result
    } catch {
      continue
    }
  }
  return null
}

export function renderGoals(result: PlainGoalResult | null): string {
  if (!result || !result.goals?.length) return "No goals."
  if (result.goals.length === 1) return result.goals[0]!
  return result.goals.map((g, i) => `goal ${i + 1}\n${g}`).join("\n\n")
}

function showInfoBuffer(editor: Editor, text: string): BufferModel {
  const origin = editor.selectedWindowId
  let info = [...editor.buffers.values()].find(b => b.name === LEAN_INFO_BUFFER)
  if (!info) {
    info = new BufferModel({ name: LEAN_INFO_BUFFER, text, kind: "scratch", mode: "text" })
    editor.addBuffer(info)
  } else {
    info.readOnly = false
    info.setText(text, false)
  }
  info.point = 0
  info.readOnly = true
  editor.displayBufferInOtherWindow(info.id)
  editor.selectWindow(origin)
  return info
}

/** Fetch the goal at point and refresh `*lean-info*`. Exported for tests and the toggle command. */
export async function leanUpdateInfo(editor: Editor, buffer: BufferModel): Promise<void> {
  if (buffer.mode !== "lean4") return
  // No initialized workspace ⇒ don't render "No goals." (reads as proof-complete); say why.
  if (!activeWorkspaces(editor, buffer).length) {
    showInfoBuffer(editor, LEAN_NO_SERVER_MSG)
    void editor.changed("lean-info")
    return
  }
  const result = await requestPlainGoal(editor, buffer)
  // Drop the result if the user moved on while we were awaiting LSP.
  if (editor.currentBuffer !== buffer) return
  showInfoBuffer(editor, renderGoals(result))
  void editor.changed("lean-info")
}

type DebounceState = { timer: ReturnType<typeof setTimeout> | null }
const debounce = new WeakMap<Editor, DebounceState>()

function scheduleGoalUpdate(editor: Editor, buffer: BufferModel): void {
  if (buffer.mode !== "lean4") return
  if (!editor.isMinorModeEnabled("lean4-info-mode", buffer)) return
  const state = debounce.get(editor) ?? { timer: null }
  debounce.set(editor, state)
  if (state.timer) clearTimeout(state.timer)
  state.timer = setTimeout(() => {
    state.timer = null
    void leanUpdateInfo(editor, buffer)
  }, LEAN_GOAL_DEBOUNCE_MS)
}

export function cancelPendingGoalUpdate(editor: Editor): void {
  const state = debounce.get(editor)
  if (state?.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
}

export function install(editor: Editor): void {
  registerLeanClient()

  const keymap = new Keymap("lean4-map")
  keymap.bind("C-c C-i", "lean4-toggle-info")
  defineMode({
    name: "lean4",
    parent: "prog-mode",
    commentStart: "--",
    keymap,
    fontLock: leanFontLock,
  })

  defineMinorMode({
    name: "lean4-info-mode",
    lighter: " LeanInfo",
    onDisable: ed => cancelPendingGoalUpdate(ed),
  })

  editor.command("lean4-mode", ({ editor, buffer }) => editor.enterMode(buffer, "lean4"),
    "Major mode for editing Lean 4 files.")

  // inferMode() doesn't know .lean; pick it up at find-file time instead.
  addHook("find-file-hook", ({ buffer }) => {
    if (buffer.path && /\.lean$/i.test(buffer.path)) enterMode(buffer, "lean4")
  })

  editor.command("lean4-toggle-info", async ({ editor, buffer }) => {
    const enabled = editor.toggleMinorMode("lean4-info-mode", { buffer })
    if (enabled) await leanUpdateInfo(editor, buffer)
    else cancelPendingGoalUpdate(editor)
    editor.message(`Lean info ${enabled ? "enabled" : "disabled"}`)
  }, "Toggle the *lean-info* goal display for the current buffer.")

  addHook("post-command-hook", ({ editor, buffer }) => {
    scheduleGoalUpdate(editor, buffer)
  })
}
