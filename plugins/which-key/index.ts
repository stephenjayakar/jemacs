import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { Keymap } from "../../src/kernel/keymap"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { modeLineage } from "../../src/modes/mode"

type State = {
  timer: ReturnType<typeof setTimeout> | null
  prefix: string
}

const state = new WeakMap<Editor, State>()

function st(editor: Editor): State {
  let s = state.get(editor)
  if (!s) {
    s = { timer: null, prefix: "" }
    state.set(editor, s)
  }
  return s
}

/** Keymaps consulted in lookup order, mirroring Editor#activeKeymaps. */
function activeKeymaps(editor: Editor): Keymap[] {
  const maps: Keymap[] = []
  if (editor.overridingTerminalLocalMap) maps.push(editor.overridingTerminalLocalMap)
  if (editor.overridingMap) maps.push(editor.overridingMap)
  if (editor.minibuffer) return [...maps, editor.minibufferKeymap, editor.keymap]
  for (const mm of editor.activeMinorModes()) if (mm.keymap) maps.push(mm.keymap)
  for (const m of modeLineage(editor.currentBuffer.mode)) if (m.keymap) maps.push(m.keymap)
  maps.push(editor.keymap)
  return maps
}

/** Bindings whose sequence extends `prefix`, deduped so the first (highest-priority) map wins. */
export function bindingsUnder(editor: Editor, prefix: string): Array<[seq: string, cmd: string]> {
  const want = `${prefix} `
  const seen = new Map<string, string>()
  for (const keymap of activeKeymaps(editor)) {
    for (const [seq, cmd] of keymap.all()) {
      if (!seq.startsWith(want)) continue
      if (!seen.has(seq)) seen.set(seq, cmd)
    }
  }
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b))
}

/** Collapse bindings to `[nextKey, label]` pairs; deeper sequences surface as `+prefix`. */
export function describePrefix(editor: Editor, prefix: string): Array<[key: string, label: string]> {
  const skip = prefix.length + 1
  const out = new Map<string, string>()
  for (const [seq, cmd] of bindingsUnder(editor, prefix)) {
    const rest = seq.slice(skip)
    const sp = rest.indexOf(" ")
    const next = sp === -1 ? rest : rest.slice(0, sp)
    if (sp >= 0) out.set(next, "+prefix")
    else if (!out.has(next)) out.set(next, cmd)
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b))
}

export function formatWhichKey(prefix: string, entries: Array<[string, string]>, sep: string): string {
  const body = entries.map(([k, c]) => `${k}${sep}${c}`).join("  ")
  return `${prefix}-:  ${body}`
}

export function showWhichKey(editor: Editor, prefix: string): void {
  const entries = describePrefix(editor, prefix)
  if (!entries.length) return
  const sep = getCustom<string>("which-key-separator") ?? " → "
  editor.message(formatWhichKey(prefix, entries, sep))
}

function cancel(editor: Editor): void {
  const s = st(editor)
  if (s.timer) clearTimeout(s.timer)
  s.timer = null
  s.prefix = ""
}

function schedule(editor: Editor, prefix: string): void {
  const s = st(editor)
  if (s.timer) clearTimeout(s.timer)
  s.prefix = prefix
  const ms = (getCustom<number>("which-key-idle-delay") ?? 0.5) * 1000
  s.timer = setTimeout(() => {
    s.timer = null
    if (!editor.isMinorModeEnabled("which-key-mode")) return
    if (editor.keymaps.pendingSequence() !== prefix) return
    showWhichKey(editor, prefix)
  }, ms)
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defcustom("which-key-idle-delay", "number", 0.5,
    "Seconds to wait after a prefix key before showing the which-key display.")
  defcustom("which-key-separator", "string", " → ",
    "String drawn between a key and its command in the which-key display.")

  ctx.minorMode({
    name: "which-key-mode",
    lighter: " WK",
    global: true,
    onDisable: ed => cancel(ed),
  })

  editor.command("which-key-mode", ({ editor: ed, prefixArgument }) => {
    const enable = prefixArgument == null
      ? !ed.isMinorModeEnabled("which-key-mode")
      : prefixArgument > 0
    if (enable) ed.enableMinorMode("which-key-mode")
    else ed.disableMinorMode("which-key-mode")
    ed.message(`Which-Key mode ${enable ? "enabled" : "disabled"}`)
  }, "Toggle which-key: show available keys after a prefix.")

  editor.events.on("changed", ({ reason }) => {
    if (!editor.isMinorModeEnabled("which-key-mode")) return
    if (reason === "key-prefix") {
      const prefix = editor.keymaps.pendingSequence()
      if (prefix) schedule(editor, prefix)
      return
    }
    if (reason === "message") return
    cancel(editor)
  })
}
