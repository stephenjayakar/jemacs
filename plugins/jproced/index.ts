import type { Editor } from "../../src/kernel/editor"
import { BufferModel } from "../../src/kernel/buffer"
import { Keymap } from "../../src/kernel/keymap"
import { defineMode, type PaneAction, type TableSurfaceModel, type TextSpan } from "../../src/modes/mode"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { killNew } from "../../src/runtime/kill-ring"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { spawnProcess, type SpawnHandle, type SpawnOptions } from "../../src/platform/runtime"
import { listWindowLeaves } from "../../src/kernel/window"

export type JProcedAttributeKey =
  | "pid" | "ppid" | "pgrp" | "sess" | "euid" | "user" | "state" | "pri" | "nice"
  | "thcount" | "vsize" | "rss" | "pcpu" | "pmem" | "etime" | "comm" | "args" | "tree"

export type JProcedValue = string | number | null

export type JProcedProcess = {
  pid: number
  attrs: Partial<Record<JProcedAttributeKey, JProcedValue>>
}

export type JProcedColumnRule = {
  key: JProcedAttributeKey
  label: string
  align: "left" | "right"
  width?: number
  sortable?: boolean
  defaultDesc?: boolean
  alternatives?: JProcedAttributeKey[]
}

export type JProcedFormatSpec = JProcedAttributeKey | JProcedAttributeKey[]
export type JProcedFilterSpec =
  | { key: JProcedAttributeKey; regexp: string }
  | { key: JProcedAttributeKey; equals: string | number }
  | { fn: (process: JProcedProcess) => boolean }
  | { all: (processes: JProcedProcess[]) => JProcedProcess[] }

export type JProcedProvider = {
  list(): Promise<JProcedProcess[]>
}

export type JProcedDeps = {
  provider?: JProcedProvider
  spawn?: (opts: SpawnOptions) => SpawnHandle
  signal?: (pid: number, signal: string | number) => Promise<void> | void
}

type SortDirection = "asc" | "desc"
type Mark = "*"

type RenderedColumn = JProcedColumnRule & { offset: number; width: number }

type JProcedState = {
  processes: JProcedProcess[]
  displayed: JProcedProcess[]
  marks: Map<number, Mark>
  format: string | JProcedFormatSpec[]
  filter: string | JProcedFilterSpec[] | null
  sort: JProcedAttributeKey
  direction: SortDirection
  tree: boolean
  autoUpdate: boolean | "visible"
  columns: RenderedColumn[]
  linePids: number[]
  previousSamples: Map<number, { pcpu: number; pmem: number }>
}

const BUFFER_NAME = "*JProced*"
const LOG_BUFFER = "*JProced log*"
const HEADER_LINES = 1
const stateByBuffer = new WeakMap<BufferModel, JProcedState>()
const editorBuffers = new WeakMap<Editor, Set<BufferModel>>()
const editorTimers = new WeakMap<Editor, ReturnType<typeof setInterval>>()

const columnRules: Record<JProcedAttributeKey, JProcedColumnRule> = {
  pid: { key: "pid", label: "PID", align: "right", sortable: true },
  ppid: { key: "ppid", label: "PPID", align: "right", sortable: true },
  pgrp: { key: "pgrp", label: "PGrp", align: "right", sortable: true },
  sess: { key: "sess", label: "Sess", align: "right", sortable: true },
  euid: { key: "euid", label: "EUID", align: "right", sortable: true },
  user: { key: "user", label: "User", align: "left", sortable: true },
  state: { key: "state", label: "Stat", align: "left", sortable: true },
  pri: { key: "pri", label: "Pr", align: "right", sortable: true, defaultDesc: true },
  nice: { key: "nice", label: "Ni", align: "right", width: 3, sortable: true, defaultDesc: true },
  thcount: { key: "thcount", label: "TH", align: "right", sortable: true, defaultDesc: true },
  vsize: { key: "vsize", label: "VSize", align: "right", sortable: true, defaultDesc: true },
  rss: { key: "rss", label: "RSS", align: "right", sortable: true, defaultDesc: true },
  pcpu: { key: "pcpu", label: "%CPU", align: "right", sortable: true, defaultDesc: true },
  pmem: { key: "pmem", label: "%Mem", align: "right", sortable: true, defaultDesc: true },
  etime: { key: "etime", label: "ETime", align: "right", sortable: true, defaultDesc: true },
  comm: { key: "comm", label: "Command", align: "left", sortable: true },
  args: { key: "args", label: "Args", align: "left", sortable: true },
  tree: { key: "tree", label: "Tree", align: "left" },
}

const defaultFormatAlist: Record<string, JProcedFormatSpec[]> = {
  short: ["user", "pid", "tree", "pcpu", "pmem", "state", ["args", "comm"]],
  medium: ["user", "pid", "tree", "pcpu", "pmem", "vsize", "rss", "state", "etime", ["args", "comm"]],
  long: ["user", "euid", "pid", "ppid", "tree", "pri", "nice", "thcount", "pcpu", "pmem", "vsize", "rss", "state", "etime", ["args", "comm"]],
  verbose: ["user", "euid", "pid", "ppid", "pgrp", "sess", "tree", "pri", "nice", "thcount", "pcpu", "pmem", "vsize", "rss", "state", "etime", "comm", "args"],
}

function defaultFilterAlist(): Record<string, JProcedFilterSpec[]> {
  const user = process.env.USER ?? ""
  return {
    user: [{ key: "user", equals: user }],
    "user-running": [{ key: "user", equals: user }, { key: "state", regexp: "^[Rr]" }],
    all: [],
    "all-running": [{ key: "state", regexp: "^[Rr]" }],
    jemacs: [{ all: processes => descendantsOf(processes, process.pid, false) }],
  }
}

function defineCustoms(): void {
  defcustom("jproced-format-alist", "sexp", defaultFormatAlist, "Named JProced column formats.", "jproced")
  defcustom("jproced-format", "string", "short", "Current JProced listing format.", "jproced")
  defcustom("jproced-filter-alist", "sexp", defaultFilterAlist(), "Named JProced process filters.", "jproced")
  defcustom("jproced-filter", "string", "user", "Current JProced listing filter.", "jproced")
  defcustom("jproced-sort", "string", "pcpu", "Current JProced sort attribute.", "jproced")
  defcustom("jproced-descend", "boolean", true, "When non-nil, sort descending.", "jproced")
  defcustom("jproced-tree-flag", "boolean", false, "When non-nil, display processes as a tree.", "jproced")
  defcustom("jproced-auto-update-interval", "number", 5, "Seconds between automatic JProced refreshes.", "jproced")
  defcustom("jproced-auto-update-flag", "sexp", false as boolean | "visible", "Auto refresh setting: false, true, or 'visible'.", "jproced")
  defcustom("jproced-enable-color-flag", "boolean", true, "Display process attributes with richer color.", "jproced")
  defcustom("jproced-low-memory-usage-threshold", "number", 0.1, "Low memory threshold for JProced coloring.", "jproced")
  defcustom("jproced-medium-memory-usage-threshold", "number", 0.5, "Medium memory threshold for JProced coloring.", "jproced")
  defcustom("jproced-renice-command", "string", "renice", "Command used by jproced-renice.", "jproced")
  defcustom("jproced-signal-list", "sexp", [
    "HUP", "INT", "QUIT", "ABRT", "KILL", "ALRM", "TERM", "CONT", "STOP", "TSTP", "USR1", "USR2",
  ], "Signals offered by jproced-send-signal.", "jproced")
}

export function install(editor: Editor, deps: JProcedDeps = {}, ctx: PluginContext = createPluginContext(editor)): void {
  defineCustoms()
  const provider = deps.provider ?? defaultProvider(deps.spawn ?? spawnProcess)
  const spawn = deps.spawn ?? spawnProcess
  const signal = deps.signal ?? defaultSignal
  const keymap = new Keymap("jproced-mode-map")
  for (const key of ["SPC", "n", "C-n", "down"]) keymap.bind(key, "next-line")
  for (const key of ["S-SPC", "p", "C-p", "up"]) keymap.bind(key, "previous-line")
  keymap.bind("g", "jproced-revert")
  keymap.bind("m", "jproced-mark")
  keymap.bind("d", "jproced-mark")
  keymap.bind("u", "jproced-unmark")
  keymap.bind("backspace", "jproced-unmark-backward")
  keymap.bind("S-m", "jproced-mark-all")
  keymap.bind("S-u", "jproced-unmark-all")
  keymap.bind("t", "jproced-toggle-marks")
  keymap.bind("S-c", "jproced-mark-children")
  keymap.bind("S-p", "jproced-mark-parents")
  keymap.bind("f", "jproced-filter-interactive")
  keymap.bind("enter", "jproced-refine")
  keymap.bind("return", "jproced-refine")
  keymap.bind("C-m", "jproced-refine")
  keymap.bind("s c", "jproced-sort-pcpu")
  keymap.bind("s m", "jproced-sort-pmem")
  keymap.bind("s p", "jproced-sort-pid")
  keymap.bind("s s", "jproced-sort-start")
  keymap.bind("s S", "jproced-sort-interactive")
  keymap.bind("s t", "jproced-sort-time")
  keymap.bind("s u", "jproced-sort-user")
  keymap.bind("S-t", "jproced-toggle-tree")
  keymap.bind("S-f", "jproced-format-interactive")
  keymap.bind("o", "jproced-omit-processes")
  keymap.bind("x", "jproced-send-signal")
  keymap.bind("k", "jproced-send-signal")
  keymap.bind("r", "jproced-renice")
  keymap.bind("i", "jproced-inspect-process")
  keymap.bind("w p", "jproced-copy-pid")
  keymap.bind("w c", "jproced-copy-command")
  keymap.bind("?", "jproced-help")
  keymap.bind("h", "describe-mode")
  keymap.bind("q", "quit-window")

  defineMode({
    name: "jproced-mode",
    parent: "text",
    keymap,
    fontLock: jprocedFontLock,
    tableSurface: jprocedTableSurface,
    paneAction: (_buffer, action) => handlePaneAction(editor, action),
    mouseClick(buffer, point) {
      buffer.point = point
      return true
    },
  })

  ctx.command("jproced", async ({ editor }) => {
    const buffer = await openJProced(editor, provider)
    editor.switchToBuffer(buffer.id)
    editor.message("Type q to quit, ? for help")
    ensureTimer(editor, provider)
  }, "Display a rich process list inspired by GNU proced.")

  ctx.command("jproced-update", async ({ editor, buffer, prefixArgument }) => {
    if (buffer.mode !== "jproced-mode") return
    await updateJProced(editor, buffer, provider, { revert: prefixArgument != null || !stateByBuffer.get(buffer)?.processes.length })
  }, "Refresh the JProced process listing.")

  ctx.command("jproced-revert", async ({ editor, buffer }) => {
    if (buffer.mode === "jproced-mode") await updateJProced(editor, buffer, provider, { revert: true })
  }, "Re-read all running processes for this JProced buffer.")

  ctx.command("jproced-toggle-auto-update", ({ editor, buffer, prefixArgument }) => {
    const st = mustState(buffer)
    st.autoUpdate = prefixArgument == null ? !st.autoUpdate : prefixArgument > 0
    ensureTimer(editor, provider)
    editor.message(`JProced auto update ${st.autoUpdate ? "enabled" : "disabled"}`)
  }, "Toggle automatic JProced updates.")

  ctx.command("jproced-mark", ({ buffer, prefixArgument }) => markByCount(buffer, prefixArgument ?? 1, true), "Mark current or next processes.")
  ctx.command("jproced-unmark", ({ buffer, prefixArgument }) => markByCount(buffer, prefixArgument ?? 1, false), "Unmark current or next processes.")
  ctx.command("jproced-unmark-backward", ({ buffer, prefixArgument }) => markByCount(buffer, -(prefixArgument ?? 1), false), "Unmark previous processes.")
  ctx.command("jproced-mark-all", ({ editor, buffer }) => { markAll(buffer, true); editor.message(`Marked ${mustState(buffer).marks.size} processes`) }, "Mark all listed processes.")
  ctx.command("jproced-unmark-all", ({ editor, buffer }) => { markAll(buffer, false); editor.message("Unmarked all processes") }, "Remove all JProced marks.")
  ctx.command("jproced-toggle-marks", ({ buffer }) => toggleMarks(buffer), "Toggle marked and unmarked processes.")
  ctx.command("jproced-mark-children", ({ editor, buffer, prefixArgument }) => markRelatives(editor, buffer, "children", prefixArgument != null), "Mark process at point and its descendants.")
  ctx.command("jproced-mark-parents", ({ editor, buffer, prefixArgument }) => markRelatives(editor, buffer, "parents", prefixArgument != null), "Mark process at point and its parents.")
  ctx.command("jproced-omit-processes", ({ editor, buffer, prefixArgument }) => omitProcesses(editor, buffer, prefixArgument), "Omit marked processes, or lines selected by prefix argument.")
  ctx.command("jproced-filter-interactive", async ({ editor, buffer, args }) => {
    const filters = getFilterAlist()
    const choice = args[0] ?? await editor.completingRead("Filter: ", { collection: ["", ...Object.keys(filters)], history: "jproced-filter" })
    if (choice == null) return
    const st = mustState(buffer)
    st.filter = choice === "" ? null : choice
    await updateJProced(editor, buffer, provider, { revert: true })
  }, "Choose a named JProced filter.")
  ctx.command("jproced-refine", ({ editor, buffer }) => refineAtPoint(editor, buffer), "Refine current listing by the process field at point.")
  ctx.command("jproced-sort-interactive", async ({ editor, buffer, args, prefixArgument }) => {
    const choice = args[0] ?? await editor.completingRead("Sort attribute: ", { collection: sortableKeys(), history: "jproced-sort" })
    if (!choice) return
    setSort(buffer, choice as JProcedAttributeKey, prefixArgument)
  }, "Sort JProced by an attribute.")
  for (const [name, key] of Object.entries({ pcpu: "pcpu", pmem: "pmem", pid: "pid", start: "etime", time: "etime", user: "user" })) {
    ctx.command(`jproced-sort-${name}`, ({ buffer, prefixArgument }) => setSort(buffer, key as JProcedAttributeKey, prefixArgument), `Sort JProced by ${key}.`)
  }
  ctx.command("jproced-format-interactive", async ({ editor, buffer, args }) => {
    const formats = getFormatAlist()
    const choice = args[0] ?? await editor.completingRead("Format: ", { collection: Object.keys(formats), history: "jproced-format" })
    if (!choice) return
    const st = mustState(buffer)
    st.format = choice
    render(buffer)
  }, "Choose a JProced column format.")
  ctx.command("jproced-toggle-tree", ({ editor, buffer, prefixArgument }) => {
    const st = mustState(buffer)
    st.tree = prefixArgument == null ? !st.tree : prefixArgument > 0
    render(buffer)
    editor.message(`JProced process tree display ${st.tree ? "enabled" : "disabled"}`)
  }, "Toggle JProced process tree display.")
  ctx.command("jproced-send-signal", async ({ editor, buffer, args }) => {
    const targets = markedOrCurrent(buffer)
    if (!targets.length) return editor.message("No process at point")
    const signals = getCustom<string[]>("jproced-signal-list") ?? []
    const sig = args[0] ?? await editor.completingRead(`Send signal [TERM] (${targets.length} process${targets.length === 1 ? "" : "es"}): `, {
      collection: signals,
      initialValue: "TERM",
      history: "jproced-signal",
    })
    if (!sig) return
    await operate(editor, "Signal", targets, pid => signal(pid, sig), `${sig}`)
  }, "Send a signal to marked processes, or the process at point.")
  ctx.command("jproced-renice", async ({ editor, buffer, args }) => {
    const targets = markedOrCurrent(buffer)
    if (!targets.length) return editor.message("No process at point")
    const priority = args[0] ?? await editor.prompt("New priority: ", "", "jproced-renice")
    if (priority == null || priority.trim() === "") return
    const cmd = getCustom<string>("jproced-renice-command") ?? "renice"
    await operate(editor, "Renice", targets, pid => runExit(spawn, [cmd, priority, "-p", String(pid)]), priority)
  }, "Renice marked processes, or the process at point.")
  ctx.command("jproced-inspect-process", ({ editor, buffer }) => inspectProcess(editor, buffer), "Show details for the process at point.")
  ctx.command("jproced-copy-pid", ({ editor, buffer }) => copyField(editor, buffer, "pid"), "Copy the process id at point.")
  ctx.command("jproced-copy-command", ({ editor, buffer }) => copyField(editor, buffer, "args"), "Copy the process command at point.")
  ctx.command("jproced-why", ({ editor }) => {
    const existing = [...editor.buffers.values()].find(b => b.name === LOG_BUFFER)
    if (existing) editor.switchToBuffer(existing.id)
  }, "Show the JProced operation log.")
  ctx.command("jproced-help", ({ editor }) => editor.message("n/p move, m/u mark, f filter, s sort, F format, T tree, k signal, r renice, i inspect"), "Show short JProced help.")
  ctx.command("jproced-undo", ({ editor }) => editor.message("JProced operations are stateful; use g to refresh or marks commands to adjust listing."), "Explain JProced undo behavior.")

  ctx.onDispose(() => {
    const timer = editorTimers.get(editor)
    if (timer) clearInterval(timer)
    editorTimers.delete(editor)
  })
}

async function openJProced(editor: Editor, provider: JProcedProvider): Promise<BufferModel> {
  const existing = [...editor.buffers.values()].find(b => b.name === BUFFER_NAME)
  if (existing) {
    editor.enterMode(existing, "jproced-mode")
    await updateJProced(editor, existing, provider, { revert: true })
    return existing
  }
  const buffer = new BufferModel({ name: BUFFER_NAME, kind: "scratch", mode: "jproced-mode" })
  buffer.readOnly = true
  editor.addBuffer(buffer)
  editor.enterMode(buffer, "jproced-mode")
  initState(buffer)
  registerBuffer(editor, buffer)
  await updateJProced(editor, buffer, provider, { revert: true })
  return buffer
}

function initState(buffer: BufferModel): JProcedState {
  const st: JProcedState = {
    processes: [],
    displayed: [],
    marks: new Map(),
    format: getCustom<string>("jproced-format") ?? "short",
    filter: getCustom<string>("jproced-filter") ?? "user",
    sort: (getCustom<string>("jproced-sort") ?? "pcpu") as JProcedAttributeKey,
    direction: getCustom<boolean>("jproced-descend") === false ? "asc" : "desc",
    tree: getCustom<boolean>("jproced-tree-flag") ?? false,
    autoUpdate: getCustom<boolean | "visible">("jproced-auto-update-flag") ?? false,
    columns: [],
    linePids: [],
    previousSamples: new Map(),
  }
  stateByBuffer.set(buffer, st)
  return st
}

function registerBuffer(editor: Editor, buffer: BufferModel): void {
  const set = editorBuffers.get(editor) ?? new Set<BufferModel>()
  set.add(buffer)
  editorBuffers.set(editor, set)
}

async function updateJProced(editor: Editor, buffer: BufferModel, provider: JProcedProvider, options: { revert?: boolean; quiet?: boolean } = {}): Promise<void> {
  const st = stateByBuffer.get(buffer) ?? initState(buffer)
  registerBuffer(editor, buffer)
  const oldPid = pidAtPoint(buffer)
  const oldKey = keyAtPoint(buffer)
  if (options.revert || !st.processes.length) st.processes = await provider.list()
  st.marks = new Map([...st.marks].filter(([pid]) => st.processes.some(p => p.pid === pid)))
  st.displayed = sortProcesses(filterProcesses(st.processes, st.filter), st.sort, st.direction)
  if (st.tree) st.displayed = treeProcesses(st.displayed)
  render(buffer)
  restorePoint(buffer, oldPid, oldKey)
  if (!options.quiet) editor.message(`JProced: ${st.displayed.length} process${st.displayed.length === 1 ? "" : "es"}`)
}

function render(buffer: BufferModel): void {
  const st = mustState(buffer)
  const rows = st.displayed
  const format = resolveFormat(st)
  const columns = renderedColumns(rows, format)
  st.columns = columns
  st.linePids = rows.map(p => p.pid)
  const header = `  ${columns.map(c => justify(c.label, c.width, c.align)).join(" ")}`
  const lines = [header]
  for (const p of rows) {
    const mark = st.marks.has(p.pid) ? "*" : " "
    const cells = columns.map(c => formatCell(p, c.key).text)
    lines.push(`${mark} ${cells.map((cell, i) => justify(cell, columns[i]!.width, columns[i]!.align)).join(" ")}`)
  }
  const point = buffer.point
  buffer.readOnly = false
  buffer.setText(lines.join("\n"), false, false)
  buffer.readOnly = true
  buffer.point = Math.min(point, buffer.text.length)
}

function renderedColumns(rows: JProcedProcess[], format: JProcedFormatSpec[]): RenderedColumn[] {
  let offset = 2
  const out: RenderedColumn[] = []
  for (const spec of format) {
    const key = Array.isArray(spec) ? spec.find(k => rows.some(p => attr(p, k) != null)) ?? spec[0]! : spec
    const rule = columnRules[key]
    if (!rule) continue
    const labelWidth = rule.label.length
    const valueWidth = Math.max(labelWidth, ...rows.map(p => formatCell(p, key).text.length))
    const width = rule.width ?? Math.min(Math.max(valueWidth, 1), key === "args" ? 80 : 24)
    out.push({ ...rule, offset, width })
    offset += width + 1
  }
  return out
}

function resolveFormat(st: JProcedState): JProcedFormatSpec[] {
  if (Array.isArray(st.format)) return st.format
  return getFormatAlist()[st.format] ?? defaultFormatAlist.short
}

function getFormatAlist(): Record<string, JProcedFormatSpec[]> {
  return getCustom<Record<string, JProcedFormatSpec[]>>("jproced-format-alist") ?? defaultFormatAlist
}

function getFilterAlist(): Record<string, JProcedFilterSpec[]> {
  return getCustom<Record<string, JProcedFilterSpec[]>>("jproced-filter-alist") ?? defaultFilterAlist()
}

function filterProcesses(processes: JProcedProcess[], filter: string | JProcedFilterSpec[] | null): JProcedProcess[] {
  let result = [...processes]
  const specs = typeof filter === "string" ? getFilterAlist()[filter] ?? [] : filter ?? []
  for (const spec of specs) {
    if ("all" in spec) {
      result = spec.all(result)
    } else if ("fn" in spec) {
      result = result.filter(spec.fn)
    } else if ("regexp" in spec) {
      const re = new RegExp(spec.regexp)
      result = result.filter(p => re.test(String(attr(p, spec.key) ?? "")))
    } else {
      result = result.filter(p => String(attr(p, spec.key) ?? "") === String(spec.equals))
    }
  }
  return result
}

function sortProcesses(processes: JProcedProcess[], key: JProcedAttributeKey, direction: SortDirection): JProcedProcess[] {
  const dir = direction === "desc" ? -1 : 1
  return [...processes].sort((a, b) => compareValue(attr(a, key), attr(b, key)) * dir || a.pid - b.pid)
}

function compareValue(a: JProcedValue | undefined, b: JProcedValue | undefined): number {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1
  const sa = String(a ?? "")
  const sb = String(b ?? "")
  return sa.localeCompare(sb)
}

function treeProcesses(processes: JProcedProcess[]): JProcedProcess[] {
  const byPid = new Map(processes.map(p => [p.pid, p]))
  const children = new Map<number, JProcedProcess[]>()
  for (const p of processes) {
    const ppid = Number(attr(p, "ppid"))
    if (!Number.isFinite(ppid) || !byPid.has(ppid) || ppid === p.pid) continue
    const list = children.get(ppid) ?? []
    list.push(p)
    children.set(ppid, list)
  }
  const out: JProcedProcess[] = []
  const seen = new Set<number>()
  const visit = (p: JProcedProcess, depth: number) => {
    if (seen.has(p.pid)) return
    seen.add(p.pid)
    p.attrs.tree = depth
    out.push(p)
    for (const child of children.get(p.pid) ?? []) visit(child, depth + 1)
  }
  for (const p of processes) {
    const ppid = Number(attr(p, "ppid"))
    if (!byPid.has(ppid) || ppid === p.pid) visit(p, 0)
  }
  for (const p of processes) visit(p, 0)
  return out
}

function attr(process: JProcedProcess, key: JProcedAttributeKey): JProcedValue | undefined {
  if (key === "pid") return process.pid
  return process.attrs[key]
}

function formatCell(process: JProcedProcess, key: JProcedAttributeKey): { text: string; numeric?: number; face?: string; bar?: number; badge?: string } {
  const value = attr(process, key)
  if (key === "tree" && value == null) return { text: "" }
  if (value == null) return { text: "?" }
  if (key === "vsize" || key === "rss") return { text: formatBytes(Number(value) * 1024), numeric: Number(value), face: memoryFace(key, Number(value)) }
  if (key === "pcpu" || key === "pmem") {
    const n = Number(value)
    return { text: n.toFixed(1), numeric: n, face: key === "pcpu" ? "function" : "constant", bar: Math.min(100, n) }
  }
  if (key === "state") return { text: String(value), face: stateFace(String(value)), badge: stateBadge(String(value)) }
  if (key === "tree") return { text: String(value) }
  return { text: String(value).replace(/\n/g, "^J") }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "?"
  const units = ["B", "K", "M", "G", "T"]
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)}${units[i]}`
}

function memoryFace(key: JProcedAttributeKey, kb: number): string | undefined {
  if (key !== "rss") return undefined
  const totalKb = Number(process.env.JPROCED_TOTAL_MEM_KB ?? 0)
  if (!totalKb) return "constant"
  const ratio = kb / totalKb
  const low = getCustom<number>("jproced-low-memory-usage-threshold") ?? 0.1
  const medium = getCustom<number>("jproced-medium-memory-usage-threshold") ?? 0.5
  if (ratio < low) return "string"
  if (ratio < medium) return "constant"
  return "error"
}

function stateFace(state: string): string {
  if (/^R/i.test(state)) return "string"
  if (/^D/i.test(state) || /^Z/i.test(state)) return "error"
  if (/^T/i.test(state)) return "constant"
  return "comment"
}

function stateBadge(state: string): string {
  if (/^R/i.test(state)) return "running"
  if (/^Z/i.test(state)) return "zombie"
  if (/^T/i.test(state)) return "stopped"
  return "sleeping"
}

function justify(text: string, width: number, align: "left" | "right"): string {
  const clipped = text.length > width ? text.slice(0, Math.max(1, width - 1)) + "~" : text
  return align === "right" ? clipped.padStart(width) : clipped.padEnd(width)
}

function pidAtPoint(buffer: BufferModel): number | null {
  const st = stateByBuffer.get(buffer)
  if (!st) return null
  const line = buffer.lineAt(buffer.point)
  if (line < HEADER_LINES) return null
  return st.linePids[line - HEADER_LINES] ?? null
}

function keyAtPoint(buffer: BufferModel): JProcedAttributeKey | null {
  const st = stateByBuffer.get(buffer)
  if (!st) return null
  const col = buffer.lineCol().col - 1
  return st.columns.find(c => col >= c.offset && col < c.offset + c.width)?.key ?? null
}

function processAtPoint(buffer: BufferModel): JProcedProcess | null {
  const pid = pidAtPoint(buffer)
  const st = stateByBuffer.get(buffer)
  return pid == null ? null : st?.displayed.find(p => p.pid === pid) ?? null
}

function mustState(buffer: BufferModel): JProcedState {
  return stateByBuffer.get(buffer) ?? initState(buffer)
}

function restorePoint(buffer: BufferModel, pid: number | null, key: JProcedAttributeKey | null): void {
  const st = mustState(buffer)
  const line = pid == null ? -1 : st.linePids.indexOf(pid)
  if (line < 0) {
    buffer.point = Math.min(buffer.text.length, buffer.lineStarts[HEADER_LINES] ?? 0)
    return
  }
  const rowLine = line + HEADER_LINES
  const column = key ? st.columns.find(c => c.key === key) : undefined
  buffer.point = (buffer.lineStarts[rowLine] ?? 0) + (column?.offset ?? 2)
}

function markByCount(buffer: BufferModel, count: number, mark: boolean): void {
  const st = mustState(buffer)
  const startLine = Math.max(HEADER_LINES, buffer.lineAt(buffer.point))
  const step = count < 0 ? -1 : 1
  let line = startLine
  for (let i = 0; i < Math.abs(count); i++, line += step) {
    const pid = st.linePids[line - HEADER_LINES]
    if (pid == null) continue
    if (mark) st.marks.set(pid, "*")
    else st.marks.delete(pid)
  }
  render(buffer)
  const nextLine = Math.max(HEADER_LINES, Math.min(HEADER_LINES + st.linePids.length - 1, startLine + count))
  buffer.point = buffer.lineStarts[nextLine] ?? buffer.point
}

function markAll(buffer: BufferModel, mark: boolean): void {
  const st = mustState(buffer)
  if (mark) for (const p of st.displayed) st.marks.set(p.pid, "*")
  else st.marks.clear()
  render(buffer)
}

function toggleMarks(buffer: BufferModel): void {
  const st = mustState(buffer)
  for (const p of st.displayed) {
    if (st.marks.has(p.pid)) st.marks.delete(p.pid)
    else st.marks.set(p.pid, "*")
  }
  render(buffer)
}

function markRelatives(editor: Editor, buffer: BufferModel, direction: "children" | "parents", omitCurrent: boolean): void {
  const st = mustState(buffer)
  const p = processAtPoint(buffer)
  if (!p) {
    editor.message("No process at point")
    return
  }
  const relatives = direction === "children"
    ? descendantsOf(st.displayed, p.pid, !omitCurrent)
    : parentsOf(st.displayed, p.pid, !omitCurrent)
  for (const proc of relatives) st.marks.set(proc.pid, "*")
  render(buffer)
  editor.message(`Marked ${relatives.length} process${relatives.length === 1 ? "" : "es"}`)
}

function descendantsOf(processes: JProcedProcess[], pid: number, includeRoot: boolean): JProcedProcess[] {
  const children = new Map<number, JProcedProcess[]>()
  for (const p of processes) {
    const ppid = Number(attr(p, "ppid"))
    const list = children.get(ppid) ?? []
    list.push(p)
    children.set(ppid, list)
  }
  const out: JProcedProcess[] = []
  const visit = (id: number, include: boolean) => {
    const current = processes.find(p => p.pid === id)
    if (include && current) out.push(current)
    for (const child of children.get(id) ?? []) visit(child.pid, true)
  }
  visit(pid, includeRoot)
  return out
}

function parentsOf(processes: JProcedProcess[], pid: number, includeCurrent: boolean): JProcedProcess[] {
  const byPid = new Map(processes.map(p => [p.pid, p]))
  const out: JProcedProcess[] = []
  let current = byPid.get(pid)
  if (includeCurrent && current) out.push(current)
  while (current) {
    const ppid = Number(attr(current, "ppid"))
    if (!Number.isFinite(ppid) || ppid === current.pid) break
    current = byPid.get(ppid)
    if (current) out.push(current)
  }
  return out
}

function omitProcesses(editor: Editor, buffer: BufferModel, prefixArgument: number | null): void {
  const st = mustState(buffer)
  let pids: number[]
  if (prefixArgument == null) pids = [...st.marks.keys()]
  else {
    const line = buffer.lineAt(buffer.point)
    const count = Math.abs(prefixArgument)
    const start = prefixArgument < 0 ? Math.max(HEADER_LINES, line - count + 1) : line
    pids = st.linePids.slice(start - HEADER_LINES, start - HEADER_LINES + count)
  }
  const omit = new Set(pids)
  st.displayed = st.displayed.filter(p => !omit.has(p.pid))
  for (const pid of pids) st.marks.delete(pid)
  render(buffer)
  editor.message(`Omitted ${pids.length} process${pids.length === 1 ? "" : "es"}`)
}

function refineAtPoint(editor: Editor, buffer: BufferModel): void {
  const st = mustState(buffer)
  const p = processAtPoint(buffer)
  const key = keyAtPoint(buffer)
  if (!p || !key) {
    editor.message("No refinable field here")
    return
  }
  if (key === "pid") st.displayed = descendantsOf(st.displayed, p.pid, true)
  else if (key === "ppid") st.displayed = parentsOf(st.displayed, p.pid, true)
  else {
    const value = attr(p, key)
    st.displayed = st.displayed.filter(proc => attr(proc, key) === value)
  }
  render(buffer)
  editor.message(`Refined by ${key}`)
}

function setSort(buffer: BufferModel, key: JProcedAttributeKey, prefixArgument: number | null): void {
  const st = mustState(buffer)
  if (prefixArgument != null) st.direction = prefixArgument < 0 ? "desc" : "asc"
  else if (st.sort === key) st.direction = st.direction === "desc" ? "asc" : "desc"
  else st.direction = columnRules[key]?.defaultDesc ? "desc" : "asc"
  st.sort = key
  st.displayed = sortProcesses(st.displayed, st.sort, st.direction)
  if (st.tree) st.displayed = treeProcesses(st.displayed)
  render(buffer)
}

function markedOrCurrent(buffer: BufferModel): JProcedProcess[] {
  const st = mustState(buffer)
  const marked = st.displayed.filter(p => st.marks.has(p.pid))
  if (marked.length) return marked
  const current = processAtPoint(buffer)
  return current ? [current] : []
}

async function operate(editor: Editor, label: string, targets: JProcedProcess[], fn: (pid: number) => Promise<void> | void, detail: string): Promise<void> {
  const failures: string[] = []
  for (const proc of targets) {
    try {
      await fn(proc.pid)
    } catch (err) {
      failures.push(`${proc.pid} ${attr(proc, "args") ?? attr(proc, "comm") ?? ""}: ${(err as Error).message}`)
    }
  }
  if (failures.length) {
    appendLog(editor, `${label} ${detail}: ${failures.length} of ${targets.length} failed\n${failures.join("\n")}\n\f\n`)
    editor.message(`${label} ${detail}: ${failures.length} of ${targets.length} failed, type M-x jproced-why`)
  } else {
    editor.message(`${label} ${detail}: ${targets.length} process${targets.length === 1 ? "" : "es"}`)
  }
}

function appendLog(editor: Editor, text: string): void {
  const existing = [...editor.buffers.values()].find(b => b.name === LOG_BUFFER)
  const buffer = existing ?? editor.addBuffer(new BufferModel({ name: LOG_BUFFER, kind: "scratch", mode: "text" }))
  buffer.readOnly = false
  buffer.append(`${new Date().toString()}\n${text}`)
  buffer.readOnly = true
}

function inspectProcess(editor: Editor, buffer: BufferModel): void {
  const p = processAtPoint(buffer)
  if (!p) {
    editor.message("No process at point")
    return
  }
  const lines = [`PID ${p.pid}`, ""]
  for (const key of Object.keys(columnRules) as JProcedAttributeKey[]) {
    const value = attr(p, key)
    if (value != null) lines.push(`${key.padEnd(8)} ${value}`)
  }
  const out = editor.scratch(`*JProced ${p.pid}*`, lines.join("\n"), "text")
  out.readOnly = true
}

function copyField(editor: Editor, buffer: BufferModel, key: JProcedAttributeKey): void {
  const p = processAtPoint(buffer)
  if (!p) {
    editor.message("No process at point")
    return
  }
  const text = String(attr(p, key) ?? "")
  killNew(editor, text)
  editor.message(`Copied ${key}`)
}

function jprocedFontLock(buffer: BufferModel): TextSpan[] {
  const spans: TextSpan[] = []
  const st = stateByBuffer.get(buffer)
  if (!st) return spans
  let offset = 0
  for (const [lineNo, line] of buffer.text.split("\n").entries()) {
    if (lineNo === 0) spans.push({ start: offset, end: offset + line.length, face: "keyword" })
    else {
      if (line[0] === "*") spans.push({ start: offset, end: offset + 1, face: "constant" })
      for (const column of st.columns) {
        const start = offset + column.offset
        const end = Math.min(offset + line.length, start + column.width)
        if (column.key === "pid" || column.key === "ppid") spans.push({ start, end, face: "number" })
        if (column.key === "pcpu" || column.key === "pmem") spans.push({ start, end, face: "function" })
        if (column.key === "state") spans.push({ start, end, face: "constant" })
      }
    }
    offset += line.length + 1
  }
  return spans
}

function jprocedTableSurface(buffer: BufferModel): TableSurfaceModel | null {
  const st = stateByBuffer.get(buffer)
  if (!st) return null
  const pointLine = buffer.lineAt(buffer.point)
  return {
    kind: "table",
    emptyText: "No processes",
    columns: st.columns.map(column => ({
      key: column.key,
      label: column.label,
      align: column.align,
      width: column.width,
      sortable: column.sortable,
      sortDirection: st.sort === column.key ? st.direction : undefined,
    })),
    rows: st.displayed.map((process, i) => {
      const cells: TableSurfaceModel["rows"][number]["cells"] = {}
      for (const column of st.columns) {
        const cell = formatCell(process, column.key)
        cells[column.key] = { text: cell.text, value: cell.numeric, face: cell.face, bar: cell.bar, badge: cell.badge }
      }
      return {
        id: String(process.pid),
        line: i + HEADER_LINES,
        selected: pointLine === i + HEADER_LINES,
        marked: st.marks.has(process.pid),
        depth: Number(attr(process, "tree")) || 0,
        cells,
        actions: [
          { id: "inspect", label: "Info", title: "Inspect process" },
          { id: "signal-term", label: "TERM", title: "Send TERM" },
        ],
      }
    }),
  }
}

function handlePaneAction(editor: Editor, action: PaneAction): boolean {
  const buffer = editor.currentBuffer
  if (buffer.mode !== "jproced-mode") return false
  if (action.action === "sort") {
    const key = action.payload?.key
    if (typeof key === "string" && key in columnRules) setSort(buffer, key as JProcedAttributeKey, null)
    return true
  }
  if (action.action === "select-row") {
    const line = Number(action.payload?.line)
    if (Number.isFinite(line)) buffer.point = buffer.lineStarts[line] ?? buffer.point
    return true
  }
  if (action.action === "inspect") {
    const line = Number(action.payload?.line)
    if (Number.isFinite(line)) buffer.point = buffer.lineStarts[line] ?? buffer.point
    inspectProcess(editor, buffer)
    return true
  }
  if (action.action === "signal-term") {
    const line = Number(action.payload?.line)
    if (Number.isFinite(line)) buffer.point = buffer.lineStarts[line] ?? buffer.point
    void editor.run("jproced-send-signal", ["TERM"])
    return true
  }
  return false
}

function sortableKeys(): string[] {
  return (Object.keys(columnRules) as JProcedAttributeKey[]).filter(k => columnRules[k].sortable)
}

function defaultProvider(spawn: (opts: SpawnOptions) => SpawnHandle): JProcedProvider {
  return {
    async list() {
      const cmd = ["ps", "-axo", "pid=,ppid=,pgid=,sess=,uid=,user=,stat=,pri=,nice=,vsz=,rss=,pcpu=,pmem=,etime=,comm=,args="]
      return parsePs(await runCapture(spawn, cmd), { threadCount: false })
    },
  }
}

export function parsePs(text: string, options: { threadCount?: boolean } = {}): JProcedProcess[] {
  const rows: JProcedProcess[] = []
  const threadCount = options.threadCount ?? true
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    if (parts.length < (threadCount ? 16 : 15)) continue
    const pid = parts[0]
    const ppid = parts[1]
    const pgrp = parts[2]
    const sess = parts[3]
    const euid = parts[4]
    const user = parts[5]
    const state = parts[6]
    const pri = parts[7]
    const nice = parts[8]
    const thcount = threadCount ? parts[9] : "0"
    const base = threadCount ? 10 : 9
    const vsize = parts[base]
    const rss = parts[base + 1]
    const pcpu = parts[base + 2]
    const pmem = parts[base + 3]
    const etime = parts[base + 4]
    const comm = parts[base + 5]
    const args = parts.slice(base + 6)
    const nPid = Number(pid)
    if (!Number.isFinite(nPid)) continue
    rows.push({
      pid: nPid,
      attrs: {
        pid: nPid,
        ppid: num(ppid),
        pgrp: num(pgrp),
        sess: num(sess),
        euid: num(euid),
        user: user ?? "",
        state: state ?? "",
        pri: num(pri),
        nice: num(nice),
        thcount: num(thcount),
        vsize: num(vsize),
        rss: num(rss),
        pcpu: Number(pcpu) || 0,
        pmem: Number(pmem) || 0,
        etime: etime ?? "",
        comm: comm ?? "",
        args: args.length ? args.join(" ") : comm ?? "",
      },
    })
  }
  return rows
}

function num(s: string | undefined): number {
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

async function runCapture(spawn: (opts: SpawnOptions) => SpawnHandle, cmd: string[]): Promise<string> {
  const proc = spawn({ cmd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr), proc.exited])
  if (code !== 0) return ""
  void stderr
  return stdout
}

async function runExit(spawn: (opts: SpawnOptions) => SpawnHandle, cmd: string[]): Promise<void> {
  const proc = spawn({ cmd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr), proc.exited])
  if (code !== 0) throw new Error((stderr || stdout || `exit ${code ?? "?"}`).trim())
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
  return out + decoder.decode()
}

function defaultSignal(pid: number, signal: string | number): void {
  process.kill(pid, signal as never)
}

function ensureTimer(editor: Editor, provider: JProcedProvider): void {
  if (editorTimers.has(editor)) return
  const timer = setInterval(() => {
    const interval = Math.max(1, getCustom<number>("jproced-auto-update-interval") ?? 5)
    const now = Date.now()
    const last = editor.locals.get("jproced-last-auto-update") as number | undefined
    if (last && now - last < interval * 1000) return
    editor.locals.set("jproced-last-auto-update", now)
    for (const buffer of editorBuffers.get(editor) ?? []) {
      const st = stateByBuffer.get(buffer)
      if (!st?.autoUpdate) continue
      if (st.autoUpdate === "visible" && !isVisible(editor, buffer)) continue
      void updateJProced(editor, buffer, provider, { revert: true, quiet: true })
    }
  }, 1000)
  ;(timer as { unref?: () => void }).unref?.()
  editorTimers.set(editor, timer)
}

function isVisible(editor: Editor, buffer: BufferModel): boolean {
  return listWindowLeaves(editor.windowLayout).some(leaf => leaf.bufferId === buffer.id)
}
