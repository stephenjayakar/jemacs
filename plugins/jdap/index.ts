import { basename, dirname, extname, join, resolve } from "node:path"
import { BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { Keymap } from "../../src/kernel/keymap"
import { findWindowLeaf, listWindowLeaves, type WindowId } from "../../src/kernel/window"
import { findProjectRoot } from "../../src/lsp/project-root"
import { defineMode, type FaceName, type GutterDecoration, type TextSpan } from "../../src/modes/mode"
import { mkdir, fileExists, homedir, readFileText, writeFileText } from "../../src/platform/runtime"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { defface } from "../../src/runtime/faces"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { jdapAdapter, jdapTaskProvider, listJdapConfigurationProviders } from "../../src/dap/api"
import { installBuiltinJdapAdapters } from "../../src/dap/adapters"
import {
  expandLaunchConfiguration,
  parseLaunchJson,
  resolveCompound,
  visibleLaunchItems,
} from "../../src/dap/config"
import { DapSession } from "../../src/dap/session"
import type {
  JdapCompoundConfiguration,
  JdapContext,
  JdapLaunchConfiguration,
  JdapSourceBreakpoint,
  LaunchJson,
} from "../../src/dap/types"
import { sessions as jtermSessions } from "../jterm"
import { spawnSession } from "../jterm/session"

const SIDEBAR_NAME = "*Run and Debug*"
const CONSOLE_NAME = "*Debug Console*"
const LOG_NAME = "*jdap-adapter-log*"
const SIDEBAR_MODE = "jdap-ui-mode"
const CONSOLE_MODE = "jdap-repl-mode"
const UI_ACTIONS = "jdap-ui-actions"
const CONSOLE_PROMPT_START = "jdap-console-prompt-start"

const BREAKPOINT_FACE = "jdap-breakpoint-face" as FaceName
const BREAKPOINT_PENDING_FACE = "jdap-breakpoint-pending-face" as FaceName
const EXECUTION_FACE = "jdap-execution-line-face" as FaceName
const EXECUTION_GUTTER_FACE = "jdap-execution-gutter-face" as FaceName
const OUTPUT_ERROR_FACE = "jdap-output-error-face" as FaceName

type PersistedProject = {
  breakpoints: JdapSourceBreakpoint[]
  watches: string[]
  lastSelection?: string
}
type PersistedState = { version: 1; projects: Record<string, PersistedProject> }
type UiAction =
  | { kind: "header"; section: string }
  | { kind: "frame"; sessionId: string; frameId: number }
  | { kind: "breakpoint"; id: string }
  | { kind: "session"; sessionId: string }

type EditorState = {
  loaded: boolean
  persisted: PersistedState
  projectRoot?: string
  launch?: LaunchJson
  sessions: DapSession[]
  stopAll: boolean
  expanded: Set<string>
  watchResults: Map<string, string>
  consoleEntries: string[]
  savedWindowConfiguration?: ReturnType<Editor["currentWindowConfiguration"]>
  sidebarWindowId?: WindowId
  consoleWindowId?: WindowId
  mainWindowId?: WindowId
  lastNavigatedFrame?: string
  endingGroup: boolean
  postDebugTasks: string[]
}

const states = new WeakMap<Editor, EditorState>()

function state(editor: Editor): EditorState {
  let value = states.get(editor)
  if (!value) {
    value = {
      loaded: false,
      persisted: { version: 1, projects: {} },
      sessions: [],
      stopAll: false,
      expanded: new Set(["variables", "watch", "callstack", "breakpoints"]),
      watchResults: new Map(),
      consoleEntries: [],
      endingGroup: false,
      postDebugTasks: [],
    }
    states.set(editor, value)
  }
  return value
}

function statePath(): string {
  return getCustom<string>("jdap-state-file") ?? join(homedir(), ".jemacs", "jdap-state.json")
}

async function loadState(editor: Editor): Promise<void> {
  const st = state(editor)
  if (st.loaded) return
  st.loaded = true
  const text = await readFileText(statePath()).catch(() => "")
  if (!text) return
  try {
    const parsed = JSON.parse(text) as PersistedState
    if (parsed.version === 1 && parsed.projects && typeof parsed.projects === "object") st.persisted = parsed
  } catch {
    editor.message("Ignoring invalid jdap state file")
  }
}

async function saveState(editor: Editor): Promise<void> {
  const path = statePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFileText(path, JSON.stringify(state(editor).persisted, null, 2) + "\n")
}

function projectState(editor: Editor, root = state(editor).projectRoot): PersistedProject {
  if (!root) throw new Error("No jdap project is active")
  const projects = state(editor).persisted.projects
  return projects[root] ??= { breakpoints: [], watches: [] }
}

async function contextFor(editor: Editor): Promise<JdapContext> {
  await loadState(editor)
  const file = editor.currentBuffer.path
  const root = await findProjectRoot(file ?? join(process.cwd(), ".jdap"))
  state(editor).projectRoot = root
  return {
    projectRoot: root,
    workspaceFolders: { [basename(root) || "workspace"]: root },
    file,
    cwd: editor.currentBuffer.directory() ?? root,
    env: name => process.env[name],
    configValues: getCustom<Record<string, string>>("jdap-config-values") ?? {},
  }
}

async function readLaunch(editor: Editor, context: JdapContext): Promise<LaunchJson | null> {
  const path = join(context.projectRoot, ".vscode", "launch.json")
  if (!await fileExists(path)) {
    state(editor).launch = undefined
    return null
  }
  const launch = parseLaunchJson(await readFileText(path))
  state(editor).launch = launch
  return launch
}

function generatedConfiguration(context: JdapContext): JdapLaunchConfiguration | null {
  if (!context.file) return null
  const extension = extname(context.file).toLowerCase()
  if (extension === ".py") return {
    name: "Debug current Python file",
    type: "debugpy",
    request: "launch",
    program: "${file}",
    console: "integratedTerminal",
  }
  if ([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(extension)) return {
    name: "Debug current Node file",
    type: "pwa-node",
    request: "launch",
    program: "${file}",
    cwd: "${workspaceFolder}",
    console: "integratedTerminal",
  }
  return null
}

function replaceBufferText(buffer: BufferModel, text: string, readOnly = true): void {
  const previous = buffer.readOnly
  buffer.readOnly = false
  buffer.setText(text, false, false)
  buffer.readOnly = readOnly || previous
  buffer.point = Math.min(buffer.point, buffer.text.length)
}

function sidebarBuffer(editor: Editor): BufferModel | undefined {
  return [...editor.buffers.values()].find(buffer => buffer.name === SIDEBAR_NAME)
}

function consoleBuffer(editor: Editor): BufferModel | undefined {
  return [...editor.buffers.values()].find(buffer => buffer.name === CONSOLE_NAME)
}

function actionLine(lines: string[], actions: Array<UiAction | undefined>, text: string, action?: UiAction): void {
  lines.push(text)
  actions.push(action)
}

function renderSidebar(editor: Editor): void {
  const buffer = sidebarBuffer(editor)
  if (!buffer) return
  const st = state(editor)
  const project = st.projectRoot ? projectState(editor) : { breakpoints: [], watches: [] }
  const lines: string[] = []
  const actions: Array<UiAction | undefined> = []
  actionLine(lines, actions, "RUN AND DEBUG")
  actionLine(lines, actions, "F5 Start   F6 Pause")
  actionLine(lines, actions, "F10 Step   S-F5 Stop")
  actionLine(lines, actions, st.projectRoot ? basename(st.projectRoot) : "No project")

  const section = (name: string, label: string, body: () => void) => {
    const open = st.expanded.has(name)
    actionLine(lines, actions, `${open ? "▼" : "▶"} ${label}`, { kind: "header", section: name })
    if (open) body()
  }

  section("variables", "VARIABLES", () => {
    const stopped = st.sessions.find(session => session.state === "stopped")
    if (!stopped?.scopes.length) return actionLine(lines, actions, "  (not paused)")
    for (const scope of stopped.scopes) {
      actionLine(lines, actions, `  ${scope.name}`)
      for (const variable of scope.variables) actionLine(lines, actions, `    ${variable.name} = ${variable.value}`)
    }
  })

  section("watch", "WATCH", () => {
    if (!project.watches.length) actionLine(lines, actions, "  (C-c d w to add)")
    for (const expression of project.watches) {
      actionLine(lines, actions, `  ${expression} = ${st.watchResults.get(expression) ?? "…"}`)
    }
  })

  section("callstack", "CALL STACK", () => {
    if (!st.sessions.length) actionLine(lines, actions, "  (no session)")
    for (const session of st.sessions) {
      actionLine(lines, actions, `  ${session.state === "stopped" ? "●" : session.state === "terminated" ? "○" : "▶"} ${session.name} — ${session.state}`, { kind: "session", sessionId: session.id })
      for (const thread of session.threads) {
        actionLine(lines, actions, `    Thread ${thread.id}: ${thread.name}`)
        if (thread.id !== session.selectedThreadId) continue
        for (const frame of session.frames) {
          const selected = frame.id === session.selectedFrame?.id ? "→" : " "
          actionLine(lines, actions, `    ${selected} ${frame.name}  ${frame.source?.name ?? ""}:${frame.line}`, {
            kind: "frame",
            sessionId: session.id,
            frameId: frame.id,
          })
        }
      }
    }
  })

  section("breakpoints", "BREAKPOINTS", () => {
    if (!project.breakpoints.length) actionLine(lines, actions, "  (none)")
    for (const breakpoint of project.breakpoints) {
      const glyph = !breakpoint.enabled ? "○" : breakpoint.verified === false ? "◌" : breakpoint.logMessage ? "◇" : breakpoint.condition ? "◆" : "●"
      actionLine(lines, actions, `  ${glyph} ${basename(breakpoint.path)}:${breakpoint.line}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}`, {
        kind: "breakpoint",
        id: breakpoint.id,
      })
    }
  })

  buffer.locals.set(UI_ACTIONS, actions)
  replaceBufferText(buffer, lines.join("\n") + "\n")
  void editor.changed("jdap-sidebar")
}

function renderConsole(editor: Editor): void {
  const buffer = consoleBuffer(editor)
  if (!buffer) return
  const st = state(editor)
  const existingStart = buffer.locals.get(CONSOLE_PROMPT_START) as number | undefined
  const input = existingStart == null ? "" : buffer.text.slice(existingStart)
  const parts: string[] = ["DEBUG CONSOLE\n"]
  for (const session of st.sessions) {
    for (const output of session.output) parts.push(st.sessions.length > 1 ? `[${session.name}] ${output.text}` : output.text)
  }
  for (const entry of st.consoleEntries) parts.push(entry.endsWith("\n") ? entry : `${entry}\n`)
  const prefix = parts.join("") + "> "
  replaceBufferText(buffer, prefix + input, false)
  buffer.readOnly = false
  buffer.locals.set(CONSOLE_PROMPT_START, prefix.length)
  buffer.point = buffer.text.length
  void editor.changed("jdap-console")
}

async function refreshWatches(editor: Editor): Promise<void> {
  const st = state(editor)
  if (!st.projectRoot) return
  const session = st.sessions.find(candidate => candidate.state === "stopped")
  if (!session) {
    st.watchResults.clear()
    renderSidebar(editor)
    return
  }
  for (const expression of projectState(editor).watches) {
    try {
      st.watchResults.set(expression, (await session.evaluate(expression, "watch")).result)
    } catch (error) {
      st.watchResults.set(expression, `<${error instanceof Error ? error.message : String(error)}>`)
    }
  }
  renderSidebar(editor)
}

function uiVisible(editor: Editor): boolean {
  const st = state(editor)
  return Boolean(st.sidebarWindowId && findWindowLeaf(editor.windowLayout, st.sidebarWindowId))
}

function openDebugUi(editor: Editor): void {
  if (uiVisible(editor)) {
    renderSidebar(editor)
    renderConsole(editor)
    return
  }
  const st = state(editor)
  st.savedWindowConfiguration ??= editor.currentWindowConfiguration()
  const sidebarId = editor.selectedWindowId
  const before = new Set(listWindowLeaves(editor.windowLayout).map(leaf => leaf.id))
  editor.splitWindowRight()
  const mainId = listWindowLeaves(editor.windowLayout).find(leaf => !before.has(leaf.id))!.id

  editor.selectWindow(sidebarId)
  const sidebar = editor.scratch(SIDEBAR_NAME, "", SIDEBAR_MODE)
  sidebar.readOnly = true
  editor.setSelectedWindowDedicated(true)
  editor.setWindowSplitRatio(sidebarId, (getCustom<number>("jdap-sidebar-width") ?? 28) / 100)

  editor.selectWindow(mainId)
  const beforeConsole = new Set(listWindowLeaves(editor.windowLayout).map(leaf => leaf.id))
  editor.splitWindowBelow()
  const consoleId = listWindowLeaves(editor.windowLayout).find(leaf => !beforeConsole.has(leaf.id))!.id
  editor.selectWindow(consoleId)
  const console = editor.scratch(CONSOLE_NAME, "", CONSOLE_MODE)
  console.readOnly = false
  editor.setSelectedWindowDedicated(true)
  editor.setWindowSplitRatio(mainId, 1 - (getCustom<number>("jdap-console-height") ?? 25) / 100)

  st.sidebarWindowId = sidebarId
  st.mainWindowId = mainId
  st.consoleWindowId = consoleId
  editor.selectWindow(mainId)
  renderSidebar(editor)
  renderConsole(editor)
}

function closeDebugUi(editor: Editor): void {
  const st = state(editor)
  const saved = st.savedWindowConfiguration
  st.savedWindowConfiguration = undefined
  st.sidebarWindowId = undefined
  st.consoleWindowId = undefined
  st.mainWindowId = undefined
  if (saved) editor.restoreWindowConfiguration(saved)
  editor.killBuffer(SIDEBAR_NAME)
  editor.killBuffer(CONSOLE_NAME)
  void editor.changed("jdap-ui-close")
}

async function navigateToFrame(editor: Editor, session: DapSession): Promise<void> {
  const frame = session.selectedFrame
  const path = frame?.source?.path
  if (!frame || !path) return
  const key = `${session.id}:${frame.id}`
  if (state(editor).lastNavigatedFrame === key) return
  state(editor).lastNavigatedFrame = key
  const mainId = state(editor).mainWindowId
  if (mainId && findWindowLeaf(editor.windowLayout, mainId)) editor.selectWindow(mainId)
  const buffer = await editor.openFile(path)
  buffer.minorModes.add("jdap-mode")
  const point = buffer.lineStarts[Math.max(0, frame.line - 1)] ?? 0
  buffer.point = point
  editor.setSelectedWindowPoint(point)
  editor.setSelectedWindowStartLine(Math.max(0, frame.line - 4))
  void editor.changed("jdap-frame")
}

async function runInTerminal(editor: Editor, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const argv = Array.isArray(args.args) ? args.args.map(String) : []
  if (!argv.length) throw new Error("runInTerminal request did not include args")
  const name = typeof args.title === "string" ? `*${args.title}*` : `*jdap-terminal: ${basename(argv[0]!)}*`
  const buffer = new BufferModel({ name, kind: "scratch", mode: "jterm-mode" })
  if (typeof args.cwd === "string") buffer.locals.set("default-directory", args.cwd)
  editor.addBuffer(buffer)
  const session = await spawnSession(editor, buffer, argv, {
    cwd: typeof args.cwd === "string" ? args.cwd : undefined,
    env: args.env && typeof args.env === "object" ? args.env as Record<string, string> : undefined,
    rows: 30,
    cols: 100,
    label: "jdap-terminal",
  })
  jtermSessions.set(buffer, session)
  return { processId: session.pty.pid, shellProcessId: session.pty.pid }
}

function protocolLog(editor: Editor, sessionName: string, line: string): void {
  if (getCustom<boolean>("jdap-adapter-log") !== true) return
  let buffer = [...editor.buffers.values()].find(candidate => candidate.name === LOG_NAME)
  if (!buffer) {
    buffer = new BufferModel({ name: LOG_NAME, kind: "scratch", mode: "text" })
    editor.addBuffer(buffer)
  }
  const previous = buffer.readOnly
  buffer.readOnly = false
  buffer.point = buffer.text.length
  buffer.insert(`[${sessionName}] ${line}\n`)
  buffer.readOnly = previous
}

async function handleGroupChanged(editor: Editor, session: DapSession): Promise<void> {
  const st = state(editor)
  renderSidebar(editor)
  renderConsole(editor)
  if (session.error) editor.message(`${session.name}: ${session.error}`)
  if (session.state === "stopped") {
    await navigateToFrame(editor, session)
    await refreshWatches(editor)
  }
  if (session.state === "terminated" && st.stopAll && !st.endingGroup && st.sessions.some(candidate => candidate.state !== "terminated")) {
    st.endingGroup = true
    await Promise.all(st.sessions.filter(candidate => candidate.state !== "terminated").map(candidate => candidate.disconnect()))
    st.endingGroup = false
  }
  if (st.sessions.length && st.sessions.every(candidate => candidate.state === "terminated")) {
    const provider = jdapTaskProvider()
    if (provider && st.projectRoot) {
      const context = await contextFor(editor)
      for (const task of st.postDebugTasks) await provider.run(task, context).catch(error => editor.message(`postDebugTask ${task}: ${String(error)}`))
    }
    closeDebugUi(editor)
  }
}

async function startConfigurations(
  editor: Editor,
  context: JdapContext,
  launch: LaunchJson,
  configurations: JdapLaunchConfiguration[],
  selectionName: string,
  stopAll: boolean,
): Promise<void> {
  const st = state(editor)
  if (st.sessions.some(session => session.state !== "terminated")) throw new Error("A jdap session group is already active")
  const persisted = projectState(editor, context.projectRoot)
  persisted.lastSelection = selectionName
  await saveState(editor)
  st.stopAll = stopAll
  st.postDebugTasks = []
  st.sessions = []
  st.lastNavigatedFrame = undefined
  openDebugUi(editor)
  const provider = jdapTaskProvider()
  try {
    for (const original of configurations) {
      const config = await expandLaunchConfiguration(editor, original, launch, context)
      if (config.preLaunchTask) {
        if (!provider) throw new Error(`Configuration ${config.name} requires preLaunchTask ${config.preLaunchTask}, but no jdap task provider is registered`)
        await provider.run(config.preLaunchTask, context)
      }
      if (config.postDebugTask) {
        if (!provider) throw new Error(`Configuration ${config.name} requires postDebugTask ${config.postDebugTask}, but no jdap task provider is registered`)
        st.postDebugTasks.push(config.postDebugTask)
      }
      const adapter = jdapAdapter(config.type)
      if (!adapter) throw new Error(`No jdap adapter is registered for debug type ${config.type}`)
      const descriptor = await adapter.resolve(config, context)
      const session = new DapSession(config.name, config, descriptor, {
        breakpoints: () => projectState(editor, context.projectRoot).breakpoints,
        breakpointChanged: () => { void saveState(editor); renderSidebar(editor) },
        runInTerminal: args => runInTerminal(editor, args),
        changed: changedSession => { void handleGroupChanged(editor, changedSession) },
      }, line => protocolLog(editor, config.name, line))
      st.sessions.push(session)
    }
    renderSidebar(editor)
    await Promise.all(st.sessions.map(session => session.start()))
  } catch (error) {
    await Promise.all(st.sessions.map(session => session.disconnect().catch(() => {})))
    if (!st.sessions.length) closeDebugUi(editor)
    throw error
  }
}

async function availableLaunch(editor: Editor): Promise<{ context: JdapContext; launch: LaunchJson; names: string[] }> {
  const context = await contextFor(editor)
  const fileLaunch = await readLaunch(editor, context)
  const providerConfigs = (await Promise.all(listJdapConfigurationProviders().map(provider => provider(context)))).flat()
    .map(config => ({ ...config, name: `provider:${config.name}` }))
  const generated = fileLaunch ? [] : [generatedConfiguration(context)].filter((value): value is JdapLaunchConfiguration => value != null)
  const launch: LaunchJson = fileLaunch
    ? { ...fileLaunch, configurations: [...fileLaunch.configurations, ...providerConfigs] }
    : { version: "0.2.0", configurations: [...generated, ...providerConfigs] }
  const names = visibleLaunchItems(launch).map(item => item.name)
  return { context, launch, names }
}

async function debugSelection(editor: Editor, requested?: string): Promise<void> {
  const { context, launch, names } = await availableLaunch(editor)
  if (!names.length) throw new Error("No launch.json configurations and no generated configuration for this buffer")
  const selection = requested ?? await editor.completingRead("Debug configuration: ", {
    collection: names,
    initialValue: projectState(editor, context.projectRoot).lastSelection,
    history: "jdap-configuration",
  })
  if (!selection) return
  const compound = launch.compounds?.find(item => item.name === selection)
  if (compound) {
    const resolved = resolveCompound(launch, selection)
    await startConfigurations(editor, context, launch, resolved.configurations, selection, compound.stopAll === true)
    return
  }
  const config = launch.configurations.find(item => item.name === selection)
  if (!config) throw new Error(`No debug configuration named ${selection}`)
  await startConfigurations(editor, context, launch, [config], selection, false)
}

async function debugAttach(editor: Editor): Promise<void> {
  const { context, launch } = await availableLaunch(editor)
  const configurations = launch.configurations.filter(config => config.request === "attach" && config.presentation?.hidden !== true)
  if (!configurations.length) throw new Error("launch.json has no visible attach configurations")
  const selection = await editor.completingRead("Attach configuration: ", {
    collection: configurations.map(config => config.name),
    history: "jdap-attach-configuration",
  })
  if (!selection) return
  const config = configurations.find(candidate => candidate.name === selection)!
  await startConfigurations(editor, context, launch, [config], selection, false)
}

function sourceOverlay(editor: Editor, buffer: BufferModel): TextSpan[] {
  for (const session of state(editor).sessions) {
    const frame = session.selectedFrame
    if (session.state !== "stopped" || !frame?.source?.path || !buffer.path) continue
    if (resolve(frame.source.path) !== resolve(buffer.path)) continue
    const start = buffer.lineStarts[Math.max(0, frame.line - 1)] ?? 0
    const end = buffer.lineStarts[frame.line] ?? buffer.text.length
    return end > start ? [{ start, end, face: EXECUTION_FACE }] : []
  }
  return []
}

function gutterDecorations(editor: Editor, buffer: BufferModel): GutterDecoration[] {
  if (!buffer.path) return []
  const path = resolve(buffer.path)
  const decorations: GutterDecoration[] = []
  for (const project of Object.values(state(editor).persisted.projects)) {
    for (const breakpoint of project.breakpoints.filter(item => resolve(item.path) === path)) {
      decorations.push({
        line: breakpoint.line,
        glyph: !breakpoint.enabled ? "×" : breakpoint.condition ? "◆" : breakpoint.logMessage ? "◇" : breakpoint.verified === false ? "○" : "●",
        face: breakpoint.verified === false ? BREAKPOINT_PENDING_FACE : BREAKPOINT_FACE,
        priority: 10,
        title: breakpoint.message,
      })
    }
  }
  for (const session of state(editor).sessions) {
    const frame = session.selectedFrame
    if (session.state === "stopped" && frame?.source?.path && resolve(frame.source.path) === path) {
      decorations.push({ line: frame.line, glyph: "▶", face: EXECUTION_GUTTER_FACE, priority: 100 })
    }
  }
  return decorations
}

async function toggleBreakpoint(editor: Editor, buffer: BufferModel): Promise<void> {
  if (!buffer.path) throw new Error("Breakpoints require a file buffer")
  const context = await contextFor(editor)
  const project = projectState(editor, context.projectRoot)
  const path = resolve(buffer.path)
  const line = buffer.lineAt(buffer.point) + 1
  const index = project.breakpoints.findIndex(item => resolve(item.path) === path && item.line === line)
  if (index >= 0) project.breakpoints.splice(index, 1)
  else project.breakpoints.push({ id: crypto.randomUUID(), path, line, enabled: true })
  buffer.minorModes.add("jdap-mode")
  await saveState(editor)
  await Promise.all(state(editor).sessions.filter(session => session.state !== "terminated").map(session => session.synchronizeBreakpoints()))
  renderSidebar(editor)
  void editor.changed("jdap-breakpoint")
}

async function breakpointAtPoint(editor: Editor, buffer: BufferModel): Promise<JdapSourceBreakpoint> {
  if (!buffer.path) throw new Error("Breakpoints require a file buffer")
  const context = await contextFor(editor)
  const project = projectState(editor, context.projectRoot)
  const path = resolve(buffer.path)
  const line = buffer.lineAt(buffer.point) + 1
  let breakpoint = project.breakpoints.find(item => resolve(item.path) === path && item.line === line)
  if (!breakpoint) {
    breakpoint = { id: crypto.randomUUID(), path, line, enabled: true }
    project.breakpoints.push(breakpoint)
  }
  return breakpoint
}

function selectedUiBreakpoint(editor: Editor, buffer: BufferModel): JdapSourceBreakpoint | undefined {
  const actions = buffer.locals.get(UI_ACTIONS) as Array<UiAction | undefined> | undefined
  const action = actions?.[buffer.lineAt(buffer.point)]
  if (action?.kind !== "breakpoint") return undefined
  return Object.values(state(editor).persisted.projects)
    .flatMap(project => project.breakpoints)
    .find(item => item.id === action.id)
}

async function resynchronizeBreakpoints(editor: Editor): Promise<void> {
  await saveState(editor)
  await Promise.all(state(editor).sessions.filter(session => session.state !== "terminated").map(session => session.synchronizeBreakpoints()))
  renderSidebar(editor)
  void editor.changed("jdap-breakpoint-update")
}

async function evaluateConsole(editor: Editor): Promise<void> {
  const buffer = consoleBuffer(editor)
  const session = state(editor).sessions.find(candidate => candidate.state === "stopped")
  if (!buffer || !session) {
    editor.message("No stopped debug session")
    return
  }
  const start = buffer.locals.get(CONSOLE_PROMPT_START) as number | undefined
  const expression = start == null ? "" : buffer.text.slice(start).trim()
  if (!expression) return
  const result = await session.evaluate(expression)
  state(editor).consoleEntries.push(`> ${expression}\n${result.result}`)
  buffer.locals.set(CONSOLE_PROMPT_START, buffer.text.length)
  renderConsole(editor)
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defcustom("jdap-state-file", "string", join(homedir(), ".jemacs", "jdap-state.json"), "Persistent jdap breakpoints, watches, and last configurations.", "jdap")
  defcustom("jdap-python-command", "string", "python3", "Python executable used to start debugpy.adapter.", "jdap")
  defcustom("jdap-node-command", "string", "node", "Node executable used to start js-debug.", "jdap")
  defcustom("jdap-node-adapter-path", "string", "", "Optional path to js-debug/src/dapDebugServer.js.", "jdap")
  defcustom("jdap-adapter-log", "boolean", false, "Log DAP messages to *jdap-adapter-log*.", "jdap")
  defcustom("jdap-sidebar-width", "number", 28, "Run and Debug sidebar width as a percentage.", "jdap")
  defcustom("jdap-console-height", "number", 25, "Debug Console height as a percentage.", "jdap")
  defcustom("jdap-config-values", "sexp", {} as Record<string, string>, "Values used by launch.json ${config:NAME} substitutions.", "jdap")

  defface(BREAKPOINT_FACE, { fg: "#f14c4c", bold: true }, "Verified breakpoint marker.", "jdap")
  defface(BREAKPOINT_PENDING_FACE, { fg: "#c5c5c5" }, "Unverified breakpoint marker.", "jdap")
  defface(EXECUTION_FACE, { bg: "#3a3d41" }, "Current debugger execution line.", "jdap")
  defface(EXECUTION_GUTTER_FACE, { fg: "#ffcc66", bold: true }, "Current debugger execution marker.", "jdap")
  defface(OUTPUT_ERROR_FACE, { fg: "#f14c4c" }, "Debugger error output.", "jdap")

  const disposeAdapters = installBuiltinJdapAdapters()
  ctx.onDispose(disposeAdapters)
  const disposeOverlay = editor.addOverlaySource(buffer => sourceOverlay(editor, buffer))
  ctx.onDispose(disposeOverlay)
  const disposeGutter = editor.addGutterDecorationSource(buffer => gutterDecorations(editor, buffer))
  ctx.onDispose(disposeGutter)

  const sourceMap = new Keymap("jdap-mode-map")
  sourceMap.bind("F9", "jdap-toggle-breakpoint")
  sourceMap.bind("C-c d b", "jdap-toggle-breakpoint")
  ctx.minorMode({ name: "jdap-mode", lighter: " JDAP", keymap: sourceMap })

  const sidebarMap = new Keymap("jdap-ui-mode-map")
  sidebarMap.bind("return", "jdap-ui-activate")
  sidebarMap.bind("RET", "jdap-ui-activate")
  sidebarMap.bind("q", "jdap-toggle-ui")
  sidebarMap.bind("SPC", "jdap-breakpoint-toggle-enabled")
  sidebarMap.bind("d", "jdap-breakpoint-delete")
  defineMode({ name: SIDEBAR_MODE, parent: "text", keymap: sidebarMap, onEnter: buffer => { buffer.readOnly = true } })

  const consoleMap = new Keymap("jdap-repl-mode-map")
  consoleMap.bind("return", "jdap-console-submit")
  consoleMap.bind("RET", "jdap-console-submit")
  defineMode({ name: CONSOLE_MODE, parent: "text", keymap: consoleMap })

  const command = (name: string, fn: Parameters<PluginContext["command"]>[1], doc: string) => ctx.command(name, fn, doc)
  command("jdap-debug", async ({ editor }) => {
    try { await debugSelection(editor) } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Select and start a VS Code launch.json configuration or compound.")
  command("jdap-debug-last", async ({ editor }) => {
    try {
      const context = await contextFor(editor)
      const last = projectState(editor, context.projectRoot).lastSelection
      if (!last) { editor.message("No previous jdap configuration for this project"); return }
      await debugSelection(editor, last)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Reload launch.json and start the last jdap configuration.")
  command("jdap-start-or-continue", async ({ editor }) => {
    const stopped = state(editor).sessions.filter(session => session.state === "stopped")
    if (stopped.length) {
      try { await Promise.all(stopped.map(session => session.continue())) } catch (error) { editor.message(String(error)) }
      return
    }
    if (state(editor).sessions.some(session => session.state !== "terminated")) {
      editor.message("Debug session is already running")
      return
    }
    try {
      const context = await contextFor(editor)
      const last = projectState(editor, context.projectRoot).lastSelection
      await debugSelection(editor, last)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Start the last configuration, select one when needed, or continue a stopped session.")
  command("jdap-attach", async ({ editor }) => {
    try { await debugAttach(editor) } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Select and start an attach configuration from launch.json.")
  command("jdap-create-launch-json", async ({ editor }) => {
    try {
      const context = await contextFor(editor)
      const config = generatedConfiguration(context)
      if (!config) throw new Error("Open a Python, JavaScript, or TypeScript file first")
      const path = join(context.projectRoot, ".vscode", "launch.json")
      if (await fileExists(path)) throw new Error(`${path} already exists`)
      const answer = await editor.prompt(`Create ${path}? (y or n) `)
      if (answer?.toLowerCase() !== "y") return
      await mkdir(dirname(path), { recursive: true })
      await writeFileText(path, JSON.stringify({ version: "0.2.0", configurations: [config] }, null, 2) + "\n")
      await editor.openFile(path)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Create a minimal .vscode/launch.json for the current file.")
  command("jdap-toggle-breakpoint", async ({ editor, buffer }) => {
    try { await toggleBreakpoint(editor, buffer) } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Toggle a source breakpoint on the current line.")
  command("jdap-breakpoint-condition", async ({ editor, buffer }) => {
    try {
      const breakpoint = await breakpointAtPoint(editor, buffer)
      const value = await editor.prompt("Breakpoint condition: ", breakpoint.condition ?? "", "jdap-condition")
      if (value == null) return
      breakpoint.condition = value || undefined
      await saveState(editor)
      await Promise.all(state(editor).sessions.map(session => session.synchronizeBreakpoints()))
      renderSidebar(editor)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Set the condition for the breakpoint on the current line.")
  command("jdap-breakpoint-hit-condition", async ({ editor, buffer }) => {
    try {
      const breakpoint = selectedUiBreakpoint(editor, buffer) ?? await breakpointAtPoint(editor, buffer)
      const value = await editor.prompt("Breakpoint hit condition: ", breakpoint.hitCondition ?? "", "jdap-hit-condition")
      if (value == null) return
      breakpoint.hitCondition = value || undefined
      await resynchronizeBreakpoints(editor)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Set the hit condition for the selected or current-line breakpoint.")
  command("jdap-breakpoint-toggle-enabled", async ({ editor, buffer }) => {
    try {
      const breakpoint = selectedUiBreakpoint(editor, buffer) ?? await breakpointAtPoint(editor, buffer)
      breakpoint.enabled = !breakpoint.enabled
      await resynchronizeBreakpoints(editor)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Enable or disable the selected or current-line breakpoint.")
  command("jdap-breakpoint-delete", async ({ editor, buffer }) => {
    const breakpoint = selectedUiBreakpoint(editor, buffer)
    if (!breakpoint) { editor.message("Select a breakpoint row first"); return }
    for (const project of Object.values(state(editor).persisted.projects)) {
      const index = project.breakpoints.findIndex(item => item.id === breakpoint.id)
      if (index >= 0) project.breakpoints.splice(index, 1)
    }
    await resynchronizeBreakpoints(editor)
  }, "Delete the breakpoint selected in the jdap sidebar.")
  command("jdap-log-point", async ({ editor, buffer }) => {
    try {
      const breakpoint = await breakpointAtPoint(editor, buffer)
      const value = await editor.prompt("Log message: ", breakpoint.logMessage ?? "", "jdap-log-point")
      if (value == null) return
      breakpoint.logMessage = value || undefined
      await saveState(editor)
      await Promise.all(state(editor).sessions.map(session => session.synchronizeBreakpoints()))
      renderSidebar(editor)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Set a log message for the breakpoint on the current line.")
  command("jdap-add-watch", async ({ editor }) => {
    try {
      const context = await contextFor(editor)
      const expression = await editor.prompt("Watch expression: ", "", "jdap-watch")
      if (!expression) return
      const watches = projectState(editor, context.projectRoot).watches
      if (!watches.includes(expression)) watches.push(expression)
      await saveState(editor)
      await refreshWatches(editor)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Add a watch expression for the current project.")
  command("jdap-evaluate", async ({ editor }) => {
    const session = state(editor).sessions.find(candidate => candidate.state === "stopped")
    if (!session) { editor.message("No stopped debug session"); return }
    const expression = await editor.prompt("Evaluate: ", "", "jdap-evaluate")
    if (!expression) return
    try { editor.message((await session.evaluate(expression)).result) } catch (error) { editor.message(String(error)) }
  }, "Evaluate an expression in the selected stack frame.")
  command("jdap-console-submit", async ({ editor }) => {
    try { await evaluateConsole(editor) } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Evaluate the current Debug Console input.")

  const eachActive = async (ed: Editor, fn: (session: DapSession) => Promise<void>) => {
    const active = state(ed).sessions.filter(session => session.state !== "terminated")
    if (!active.length) { ed.message("No active jdap session"); return }
    try { await Promise.all(active.map(fn)) } catch (error) { ed.message(error instanceof Error ? error.message : String(error)) }
  }
  command("jdap-continue", async ({ editor }) => eachActive(editor, session => session.continue()), "Continue the selected debug threads.")
  command("jdap-pause", async ({ editor }) => eachActive(editor, session => session.pause()), "Pause active debug sessions.")
  command("jdap-next", async ({ editor }) => eachActive(editor, session => session.next()), "Step over in active debug sessions.")
  command("jdap-step-in", async ({ editor }) => eachActive(editor, session => session.stepIn()), "Step into in active debug sessions.")
  command("jdap-step-out", async ({ editor }) => eachActive(editor, session => session.stepOut()), "Step out in active debug sessions.")
  command("jdap-restart", async ({ editor }) => eachActive(editor, session => session.restart()), "Restart active debug sessions when supported.")
  command("jdap-disconnect", async ({ editor }) => eachActive(editor, session => session.disconnect()), "Terminate or disconnect active debug sessions.")
  command("jdap-toggle-ui", async ({ editor }) => {
    if (uiVisible(editor)) closeDebugUi(editor)
    else {
      await contextFor(editor).catch(() => null)
      openDebugUi(editor)
    }
  }, "Toggle the jdap Run and Debug UI.")
  command("jdap-show-console", ({ editor }) => {
    openDebugUi(editor)
    const id = state(editor).consoleWindowId
    if (id) editor.selectWindow(id)
  }, "Show and select the Debug Console.")
  command("jdap-ui-activate", async ({ editor, buffer }) => {
    const actions = buffer.locals.get(UI_ACTIONS) as Array<UiAction | undefined> | undefined
    const action = actions?.[buffer.lineAt(buffer.point)]
    if (!action) return
    if (action.kind === "header") {
      const expanded = state(editor).expanded
      if (expanded.has(action.section)) expanded.delete(action.section); else expanded.add(action.section)
      renderSidebar(editor)
    } else if (action.kind === "frame") {
      const session = state(editor).sessions.find(candidate => candidate.id === action.sessionId)
      if (session) { await session.selectFrame(action.frameId); await navigateToFrame(editor, session); await refreshWatches(editor) }
    } else if (action.kind === "breakpoint") {
      const breakpoint = Object.values(state(editor).persisted.projects).flatMap(project => project.breakpoints).find(item => item.id === action.id)
      if (breakpoint) {
        const main = state(editor).mainWindowId
        if (main) editor.selectWindow(main)
        const target = await editor.openFile(breakpoint.path)
        target.point = target.lineStarts[breakpoint.line - 1] ?? 0
        editor.setSelectedWindowPoint(target.point)
      }
    }
  }, "Activate the jdap UI row at point.")

  const bindings: Array<[string, string]> = [
    ["F5", "jdap-start-or-continue"], ["F6", "jdap-pause"], ["S-F5", "jdap-disconnect"], ["C-S-F5", "jdap-restart"],
    ["F9", "jdap-toggle-breakpoint"], ["F10", "jdap-next"], ["F11", "jdap-step-in"], ["S-F11", "jdap-step-out"],
    ["C-c d d", "jdap-debug"], ["C-c d a", "jdap-attach"], ["C-c d l", "jdap-debug-last"], ["C-c d b", "jdap-toggle-breakpoint"],
    ["C-c d c", "jdap-continue"], ["C-c d p", "jdap-pause"], ["C-c d n", "jdap-next"],
    ["C-c d i", "jdap-step-in"], ["C-c d o", "jdap-step-out"], ["C-c d r", "jdap-restart"],
    ["C-c d q", "jdap-disconnect"], ["C-c d e", "jdap-evaluate"], ["C-c d w", "jdap-add-watch"],
    ["C-c d u", "jdap-toggle-ui"],
  ]
  for (const [key, name] of bindings) ctx.key("global-map", key, name)
  void loadState(editor).then(() => {
    const breakpointPaths = new Set(Object.values(state(editor).persisted.projects).flatMap(project => project.breakpoints).map(item => resolve(item.path)))
    for (const buffer of editor.buffers.values()) if (buffer.path && breakpointPaths.has(resolve(buffer.path))) buffer.minorModes.add("jdap-mode")
    return editor.changed("jdap-state-loaded")
  })
  ctx.onDispose(() => {
    for (const session of state(editor).sessions) void session.disconnect()
  })
}
