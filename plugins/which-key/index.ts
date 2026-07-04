import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { emacsKeyDescription, normalizeSequence, type Keymap } from "../../src/kernel/keymap"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { modeLineage } from "../../src/modes/mode"

type WhichKeySortOrder = "key-order-alpha" | "description-order"
type WhichKeyEntry = [key: string, label: string]

type State = {
  timer: ReturnType<typeof setTimeout> | null
  prefix: string
  page: number
  pages: WhichKeyEntry[][]
}

const state = new WeakMap<Editor, State>()

function st(editor: Editor): State {
  let s = state.get(editor)
  if (!s) {
    s = { timer: null, prefix: "", page: 0, pages: [] }
    state.set(editor, s)
  }
  return s
}

const DEFAULT_PREFIX_NAMES = new Map<string, string>([
  ["C-x 4", "other-window"],
  ["C-x 5", "other-frame"],
  ["C-x 8", "unicode"],
  ["C-x r", "register"],
])

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
export function describePrefix(editor: Editor, prefix: string): WhichKeyEntry[] {
  const skip = prefix.length + 1
  const out = new Map<string, string>()
  for (const [seq, cmd] of bindingsUnder(editor, prefix)) {
    const rest = seq.slice(skip)
    const sp = rest.indexOf(" ")
    const next = sp === -1 ? rest : rest.slice(0, sp)
    if (sp >= 0) out.set(next, prefixLabel(editor, prefix, next))
    else if (!out.has(next)) out.set(next, cmd)
  }
  return sortWhichKeyEntries([...out.entries()])
}

export function describeTopLevelGlobalBindings(editor: Editor): WhichKeyEntry[] {
  const all = editor.keymap.all()
  const prefixes = new Set<string>()
  for (const [seq] of all) {
    const sp = seq.indexOf(" ")
    if (sp >= 0) prefixes.add(seq.slice(0, sp))
  }
  return sortWhichKeyEntries(all
    .filter(([seq]) => !seq.includes(" ") && !prefixes.has(seq))
    .map(([seq, cmd]) => [seq, cmd] as WhichKeyEntry))
}

function prefixLabel(editor: Editor, prefix: string, next: string): string {
  const full = normalizeSequence(`${prefix} ${next}`)
  const rawCustom = getCustom<unknown>("which-key-prefix-name-alist")
  const custom = Array.isArray(rawCustom) ? rawCustom : []
  const found = custom.find(entry =>
    Array.isArray(entry)
    && typeof entry[0] === "string"
    && typeof entry[1] === "string"
    && normalizeSequence(entry[0]) === full
  )?.[1] as string | undefined
  const name = found ?? DEFAULT_PREFIX_NAMES.get(full)
  return name ? `+${name}` : "+prefix"
}

export function sortWhichKeyEntries(entries: WhichKeyEntry[], order = getWhichKeySortOrder()): WhichKeyEntry[] {
  return [...entries].sort((a, b) => compareWhichKeyEntry(a, b, order))
}

function getWhichKeySortOrder(): WhichKeySortOrder {
  const value = getCustom<WhichKeySortOrder>("which-key-sort-order")
  return value === "description-order" ? value : "key-order-alpha"
}

function compareWhichKeyEntry(a: WhichKeyEntry, b: WhichKeyEntry, order: WhichKeySortOrder): number {
  const ag = a[1].startsWith("+")
  const bg = b[1].startsWith("+")
  if (ag !== bg) return ag ? 1 : -1
  if (order === "description-order") {
    const byDescription = a[1].localeCompare(b[1])
    if (byDescription !== 0) return byDescription
  }
  const ar = specialKeyRank(a[0])
  const br = specialKeyRank(b[0])
  if (ar !== br) return ar - br
  return emacsKeyDescription(a[0]).localeCompare(emacsKeyDescription(b[0]))
}

function specialKeyRank(key: string): number {
  switch (emacsKeyDescription(key)) {
    case "SPC": return 0
    case "TAB": return 1
    case "RET": return 2
    default: return 3
  }
}

export function formatWhichKey(prefix: string, entries: WhichKeyEntry[], sep: string, page?: { index: number; count: number }): string {
  const pageText = page && page.count > 1 ? ` (${page.index + 1}/${page.count})` : ""
  const body = entries.map(([k, c]) => `${emacsKeyDescription(k)}${sep}${c}`).join("  ")
  return `${prefix}-:${pageText}  ${body}`
}

export function paginateWhichKey(prefix: string, entries: WhichKeyEntry[], sep: string, cols?: number): WhichKeyEntry[][] {
  const width = Math.max(1, Math.floor(cols ?? Number.POSITIVE_INFINITY))
  if (!Number.isFinite(width)) return [entries]
  let pageCount = 1
  let pages: WhichKeyEntry[][] = []
  for (;;) {
    pages = paginateWhichKeyWithCount(prefix, entries, sep, width, pageCount)
    if (pages.length === pageCount) return pages
    pageCount = pages.length
  }
}

function paginateWhichKeyWithCount(prefix: string, entries: WhichKeyEntry[], sep: string, width: number, pageCount: number): WhichKeyEntry[][] {
  const pages: WhichKeyEntry[][] = []
  let page: WhichKeyEntry[] = []
  for (const entry of entries) {
    const candidate = [...page, entry]
    if (page.length > 0 && formatWhichKey(prefix, candidate, sep, { index: pages.length, count: pageCount }).length > width) {
      pages.push(page)
      page = [entry]
    } else {
      page = candidate
    }
  }
  if (page.length || !pages.length) pages.push(page)
  return pages
}

export function showWhichKey(editor: Editor, prefix: string, page = 0): void {
  const entries = describePrefix(editor, prefix)
  if (!entries.length) return
  showWhichKeyEntries(editor, prefix, entries, page)
}

export function showWhichKeyEntries(editor: Editor, prefix: string, entries: WhichKeyEntry[], page = 0): void {
  const sep = getCustom<string>("which-key-separator") ?? " → "
  const pages = paginateWhichKey(prefix, entries, sep, editor.lastViewport?.cols)
  const s = st(editor)
  s.prefix = prefix
  s.pages = pages
  s.page = ((page % pages.length) + pages.length) % pages.length
  editor.message(formatWhichKey(prefix, pages[s.page]!, sep, { index: s.page, count: pages.length }))
}

function showPage(editor: Editor, delta: number): void {
  const s = st(editor)
  if (!s.prefix || !s.pages.length) {
    editor.message("No which-key popup is active")
    return
  }
  const sep = getCustom<string>("which-key-separator") ?? " → "
  s.page = ((s.page + delta) % s.pages.length + s.pages.length) % s.pages.length
  editor.message(formatWhichKey(s.prefix, s.pages[s.page]!, sep, { index: s.page, count: s.pages.length }))
}

function cancel(editor: Editor): void {
  const s = st(editor)
  if (s.timer) clearTimeout(s.timer)
  s.timer = null
  s.prefix = ""
  s.page = 0
  s.pages = []
}

function schedule(editor: Editor, prefix: string): void {
  const s = st(editor)
  if (s.timer) clearTimeout(s.timer)
  s.prefix = prefix
  s.page = 0
  s.pages = []
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
  defcustom("which-key-sort-order", "string", "key-order-alpha",
    "Sort order for which-key entries: key-order-alpha or description-order.")
  defcustom("which-key-prefix-name-alist", "sexp", [],
    "Alist mapping prefix key sequences to which-key group names.")

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

  editor.command("which-key-show-next-page-cycle", ({ editor: ed }) => {
    showPage(ed, 1)
  }, "Show the next which-key page, cycling at the end.")

  editor.command("which-key-show-previous-page-cycle", ({ editor: ed }) => {
    showPage(ed, -1)
  }, "Show the previous which-key page, cycling at the beginning.")

  editor.command("which-key-show-top-level", ({ editor: ed }) => {
    const entries = describeTopLevelGlobalBindings(ed)
    if (!entries.length) return ed.message("No top-level bindings")
    showWhichKeyEntries(ed, "Top-level", entries)
  }, "Show all top-level non-prefix global bindings.")

  editor.events.on("changed", ({ reason }) => {
    if (!editor.isMinorModeEnabled("which-key-mode")) return
    if (reason === "key-prefix") {
      const prefix = editor.keymaps.pendingSequence()
      if (prefix) schedule(editor, prefix)
      return
    }
    if (reason.startsWith("command:which-key-show-")) return
    // Only real user actions dismiss the popup. Cancelling on every other
    // reason races against async `changed` emissions from unrelated setup
    // (theme, minor-mode toggles) that land after the popup is shown.
    if (reason.startsWith("command:") || reason === "mouse-click" || reason === "switch-buffer") {
      cancel(editor)
    }
  })
}
