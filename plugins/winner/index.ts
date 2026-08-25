import type { Editor } from "../../src/kernel/editor"
import { Keymap } from "../../src/kernel/keymap"
import type { RegisterContents } from "../../src/kernel/register"
import type { WindowNode } from "../../src/kernel/window"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"

const MAX_HISTORY = 200

type WindowConfiguration = Extract<RegisterContents, { kind: "window-configuration" }>

type HistoryEntry = {
  config: WindowConfiguration
  signature: string
}

type WinnerState = {
  entries: HistoryEntry[]
  index: number
  pending: HistoryEntry | null
}

const states = new WeakMap<Editor, WinnerState>()

function nodeSignature(node: WindowNode): unknown {
  if (node.kind === "leaf") {
    return {
      kind: "leaf",
      id: node.id,
      bufferId: node.bufferId,
      dedicated: node.dedicated,
    }
  }
  return {
    kind: "split",
    direction: node.direction,
    firstRatio: node.firstRatio,
    first: nodeSignature(node.first),
    second: nodeSignature(node.second),
  }
}

function configSignature(config: WindowConfiguration): string {
  return JSON.stringify({
    layout: nodeSignature(config.layout),
    selectedWindowId: config.selectedWindowId,
    currentBufferId: config.currentBufferId,
  })
}

function currentEntry(editor: Editor): HistoryEntry {
  const config = editor.currentWindowConfiguration()
  return { config, signature: configSignature(config) }
}

function resetState(editor: Editor): WinnerState {
  const state: WinnerState = { entries: [currentEntry(editor)], index: 0, pending: null }
  states.set(editor, state)
  return state
}

function winnerEnabled(editor: Editor): boolean {
  return editor.isMinorModeEnabled("winner-mode")
}

function stateFor(editor: Editor): WinnerState {
  return states.get(editor) ?? resetState(editor)
}

function pushEntry(state: WinnerState, entry: HistoryEntry): void {
  const current = state.entries[state.index]
  if (current?.signature === entry.signature) {
    state.entries[state.index] = entry
    return
  }
  if (state.index < state.entries.length - 1) state.entries.splice(state.index + 1)
  state.entries.push(entry)
  if (state.entries.length > MAX_HISTORY) state.entries.shift()
  state.index = state.entries.length - 1
}

function winnerCommand(name: string): boolean {
  return name === "winner-undo" || name === "winner-redo" || name === "winner-mode"
}

function recordCommandResult(editor: Editor, commandName: string): void {
  const state = states.get(editor)
  if (!state || !winnerEnabled(editor) || winnerCommand(commandName)) return

  const before = state.pending
  state.pending = null
  if (state.index < state.entries.length - 1) state.entries.splice(state.index + 1)

  const after = currentEntry(editor)
  if (!before || before.signature === after.signature) {
    state.entries[state.index] = after
    return
  }
  pushEntry(state, after)
}

function winnerUndo(editor: Editor): void {
  const state = states.get(editor)
  if (!state || !winnerEnabled(editor)) {
    editor.message("Winner mode is disabled")
    return
  }
  if (state.index <= 0) {
    editor.message("No further window configuration undo information")
    return
  }
  state.index--
  editor.restoreWindowConfiguration(state.entries[state.index]!.config)
  editor.message("Winner undo")
}

function winnerRedo(editor: Editor): void {
  const state = states.get(editor)
  if (!state || !winnerEnabled(editor)) {
    editor.message("Winner mode is disabled")
    return
  }
  if (state.index >= state.entries.length - 1) {
    editor.message("No further window configuration redo information")
    return
  }
  state.index++
  editor.restoreWindowConfiguration(state.entries[state.index]!.config)
  editor.message("Winner redo")
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const winnerMap = new Keymap("winner-mode-map")
  winnerMap.bind("C-c left", "winner-undo")
  winnerMap.bind("C-c right", "winner-redo")

  ctx.minorMode({
    name: "winner-mode",
    global: true,
    lighter: " Winner",
    keymap: winnerMap,
    onEnable: ed => {
      resetState(ed)
    },
    onDisable: ed => {
      states.delete(ed)
    },
  })

  ctx.command("winner-mode", ({ editor, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode("winner-mode")
    else if (prefixArgument != null) editor.enableMinorMode("winner-mode")
    else editor.toggleMinorMode("winner-mode")
  }, "Toggle Winner mode.")

  ctx.command("winner-undo", ({ editor }) => winnerUndo(editor),
    "Restore the previous window configuration recorded by Winner mode.")

  ctx.command("winner-redo", ({ editor }) => winnerRedo(editor),
    "Redo a window configuration undone by Winner mode.")

  ctx.hook("pre-command-hook", ({ editor: ed }) => {
    if (ed !== editor || !winnerEnabled(ed)) return
    stateFor(ed).pending = currentEntry(ed)
  })

  ctx.onDispose(editor.events.on("changed", ({ reason }) => {
    if (!reason.startsWith("command:")) return
    recordCommandResult(editor, reason.slice("command:".length))
  }))
}
