import { stat, unlink } from "node:fs/promises"
import { basename, dirname, resolve, sep } from "node:path"
import { BufferModel } from "./buffer"
import { CommandRegistry, type CommandFn } from "./command"
import { Emitter } from "./events"
import { isPrintable, Keymap, KeymapStack, keyToken, type KeyEventLike } from "./keymap"
import { digitFromKey, PrefixArgumentState } from "./prefix-argument"
import { enterMode, getMode, modeFeature, modeLineage, type CompletionCandidate, type TextSpan } from "../modes/mode"
import { allMinorModes, getMinorMode, type MinorMode } from "../modes/minor-mode"
import { makeDiredBuffer } from "../modes/dired"
import { pointFromWindowClick, type WindowClickState } from "../display/click-to-point"
import { pageScrollLines } from "../display/viewport"
import type { Theme } from "../display/theme"
import { defaultTheme } from "../themes"
import { fileCompletionCandidates } from "./completion"
import { findBackward, findForward, isearchPrompt, type IsearchState } from "./isearch"
import {
  cloneWindowNode,
  createLeafWindow,
  deleteOtherWindowLeaves,
  deleteWindowLeaf,
  findWindowLeaf,
  findWindowShowingBuffer,
  listWindowLeaves,
  nextWindowId,
  pickReusableWindow,
  removeBufferFromWindows,
  scrollWindowLeaf,
  nextEligibleWindowId,
  setWindowLeafBuffer,
  setWindowLeafDedicated,
  setWindowLeafPoint,
  setWindowLeafStartLine,
  splitWindowLeaf,
  type WindowNode,
} from "./window"
import type { RegisterContents } from "./register"
import { modeHookName, runHooks } from "./hooks"
import type { LspManager } from "../lsp/manager"
import { fileExists, readFileText, writeFileText } from "../platform/runtime"
import { invokeWithAdvice } from "../runtime/advice"
import { defcustom, getCustom } from "../runtime/custom"
import { readInteractiveArgs } from "../runtime/interactive"
import { canonicalMapName, registerKeyBinding } from "../runtime/key-registry"
import type { SourceLocation } from "../runtime/source"

export type EditorEvents = {
  changed: { reason: string }
  message: { text: string }
  minibuffer: { prompt: string }
}

type MinibufferRequest = {
  prompt: string
  bufferId: string
  historyName?: string
  historyIndex: number | null
  collection?: string[]
  completion?: "file"
  fileCompletionDirectory?: string
  resolve: (value: string | null) => void
}

export type CompletingReadOptions = {
  collection?: string[]
  completion?: "file"
  history?: string
  initialValue?: string
  defaultDirectory?: string
}

export type MinibufferCompletionFrontend = {
  refresh?: (editor: Editor) => void | Promise<void>
  complete?: (editor: Editor) => void | Promise<void>
  submitValue?: (editor: Editor) => string | undefined
  /** Nav bindings consulted ahead of minibuffer-local-map while this frontend is active,
   *  so plugins don't fight over the shared map at install() time. */
  keymap?: Keymap
}

export type MinibufferCompletionDisplay = {
  text: string
  selectedLine?: number
}

export type CompletingReadFunction = (editor: Editor, prompt: string, options: CompletingReadOptions) => Promise<string | null>

/** Pluggable completion delegate (e.g. fido flex matching). Returns candidates ordered best-first. */
export type Completer = (input: string, collection: string[]) => string[]

export type KeyDispatchResult =
  | { status: "command"; command: string }
  | { status: "pending" }
  | { status: "inserted" }
  | { status: "unmatched" }

defcustom("auto-save-interval", "number", 30,
  "Seconds of idle time between auto-saves of dirty file-visiting buffers.")
defcustom("auto-save-keystroke-interval", "number", 300,
  "Number of input events between auto-saves; checked in handleKey.")

export class Editor {
  readonly buffers = new Map<string, BufferModel>()
  private readonly fontLockCache = new WeakMap<BufferModel, { text: string; spans: TextSpan[] }>()
  private readonly overlaySources: Array<(buffer: BufferModel) => TextSpan[]> = []
  readonly commands = new CommandRegistry()
  readonly keymap = new Keymap("global-map")
  readonly minibufferKeymap = new Keymap("minibuffer-local-map")
  readonly events = new Emitter<EditorEvents>()
  readonly keymaps = new KeymapStack(() => this.activeKeymaps())
  readonly minibufferHistory = new Map<string, string[]>()
  readonly registers = new Map<string, RegisterContents>()
  readonly tabs: Array<{ name: string; bufferId: string }> = []
  private _windowLayout!: WindowNode
  /** Read-only view of the window tree. Mutate via kernel primitives (setSelectedWindowPoint etc). */
  get windowLayout(): WindowNode { return this._windowLayout }
  private set windowLayout(layout: WindowNode) { this._windowLayout = layout }
  selectedWindowId: string
  theme: Theme = defaultTheme
  selectedTab = 0
  minibuffer: MinibufferRequest | null = null
  isearch: IsearchState | null = null
  running = true
  overridingTerminalLocalMap: Keymap | null = null
  overridingMap: Keymap | null = null
  readonly prefixArg = new PrefixArgumentState()
  readonly globalMinorModes = new Set<string>()
  lastKeyEvent: KeyEventLike | null = null
  quotedInsertNext = false
  recenterCycle = 0
  macroRecording: string[] | null = null
  lastKbdMacro: string[] = []
  lsp: LspManager | null = null
  /** Stack of completing-read overrides; top wins. push/pop instead of save/restore so
   *  enable A → enable B → disable A → disable B doesn't resurrect A's function. */
  private readonly completingReadFns: CompletingReadFunction[] = []
  private readonly completionFrontends: MinibufferCompletionFrontend[] = []
  minibufferCompletionDisplay: MinibufferCompletionDisplay | null = null
  completer: Completer | null = null
  /** Gutter predicate consulted by build-display-model; modes (linum) install the policy. */
  showLineNumbers: (buffer?: BufferModel) => boolean = () => false
  /** Command currently executing (emacs `this-command`). */
  thisCommand: string | null = null
  private readonly searchRing: string[] = []
  private minibufferDepth = 0
  private readonly displayNames = new Map<string, string>()
  /** Buffer ids most-recently-selected first; killBuffer's fallback source. */
  private readonly bufferRecency: string[] = []
  private _currentBufferId!: string
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null
  private autoSaveKeystrokes = 0

  get currentBufferId(): string { return this._currentBufferId }
  set currentBufferId(id: string) {
    this._currentBufferId = id
    if (this.buffers.get(id)?.kind === "minibuffer") return
    const i = this.bufferRecency.indexOf(id)
    if (i !== -1) this.bufferRecency.splice(i, 1)
    this.bufferRecency.unshift(id)
  }

  constructor() {
    const scratch = new BufferModel({ name: "*scratch*", text: "// Try: editor.message('hello from eval')\n", kind: "scratch", mode: "javascript" })
    const messages = new BufferModel({ name: "*messages*", text: "", kind: "messages" })
    this.addBuffer(scratch)
    this.addBuffer(messages)
    this.currentBufferId = scratch.id
    const rootWindow = createLeafWindow(scratch.id, scratch.point)
    this.windowLayout = rootWindow
    this.selectedWindowId = rootWindow.id
    this.tabs.push({ name: "1", bufferId: scratch.id })
  }

  get completingReadFunction(): CompletingReadFunction | null {
    return this.completingReadFns.at(-1) ?? null
  }
  /** Direct assignment replaces the stack — single-plugin compat only. Prefer push/pop. */
  set completingReadFunction(fn: CompletingReadFunction | null) {
    this.completingReadFns.length = 0
    if (fn) this.completingReadFns.push(fn)
  }
  pushCompletingReadFunction(fn: CompletingReadFunction): void { this.completingReadFns.push(fn) }
  popCompletingReadFunction(fn: CompletingReadFunction): void {
    const i = this.completingReadFns.lastIndexOf(fn)
    if (i !== -1) this.completingReadFns.splice(i, 1)
  }

  get minibufferCompletionFrontend(): MinibufferCompletionFrontend | null {
    return this.completionFrontends.at(-1) ?? null
  }
  set minibufferCompletionFrontend(fe: MinibufferCompletionFrontend | null) {
    this.completionFrontends.length = 0
    if (fe) this.completionFrontends.push(fe)
  }
  pushMinibufferCompletionFrontend(fe: MinibufferCompletionFrontend): void { this.completionFrontends.push(fe) }
  popMinibufferCompletionFrontend(fe: MinibufferCompletionFrontend): void {
    const i = this.completionFrontends.lastIndexOf(fe)
    if (i !== -1) this.completionFrontends.splice(i, 1)
  }

  selectedWindowLeaf() {
    return findWindowLeaf(this.windowLayout, this.selectedWindowId)
  }

  /** Kernel primitive: set the selected window's stored point without bypassing persist/restore invariants. */
  setSelectedWindowPoint(point: number): void {
    this.windowLayout = setWindowLeafPoint(this.windowLayout, this.selectedWindowId, point)
  }

  /** Kernel primitive: set the selected window's first visible line (recenter, jump-to-location). */
  setSelectedWindowStartLine(line: number): void {
    this.windowLayout = setWindowLeafStartLine(this.windowLayout, this.selectedWindowId, line)
  }

  private persistSelectedWindowPoint(): void {
    const leaf = this.selectedWindowLeaf()
    if (!leaf) return
    this.windowLayout = setWindowLeafPoint(this.windowLayout, leaf.id, this.currentBuffer.point)
  }

  /** Keep the cursor on screen without recentering the whole window on focus changes. */
  syncSelectedWindowViewport(lineBudget: number): void {
    const leaf = this.selectedWindowLeaf()
    if (!leaf) return
    const buffer = this.buffers.get(leaf.bufferId)
    if (!buffer) return
    const cursorLine = this.lineAtPoint(buffer.point)
    let start = leaf.startLine
    if (cursorLine < start) start = cursorLine
    else if (cursorLine >= start + lineBudget) start = Math.max(0, cursorLine - lineBudget + 1)
    if (start !== leaf.startLine) {
      this.windowLayout = setWindowLeafStartLine(this.windowLayout, leaf.id, start)
    }
  }

  private lineAtPoint(point: number): number {
    return Math.max(0, this.currentBuffer.text.slice(0, Math.max(0, Math.min(point, this.currentBuffer.text.length))).split("\n").length - 1)
  }

  selectWindow(windowId: string): void {
    if (!findWindowLeaf(this.windowLayout, windowId)) return
    this.persistSelectedWindowPoint()
    this.selectedWindowId = windowId
    this.currentBufferId = findWindowLeaf(this.windowLayout, windowId)!.bufferId
    this.restoreSelectedWindowPoint()
  }

  /** Select a window and move point from a body click (terminal/GUI cell coordinates). */
  clickWindow(windowId: string, row: number, col: number, clickState: WindowClickState, bodyLineBudget: number): void {
    const leaf = findWindowLeaf(this.windowLayout, windowId)
    if (!leaf) return
    this.selectWindow(windowId)
    const buffer = this.buffers.get(leaf.bufferId)
    if (!buffer || buffer.readOnly && buffer.kind !== "minibuffer") return
    const point = pointFromWindowClick(buffer.text, clickState, row, col, bodyLineBudget)
    buffer.point = point
    buffer.deactivateMark()
    this.windowLayout = setWindowLeafPoint(this.windowLayout, windowId, point)
    void this.changed("mouse-click")
  }

  ensureOtherWindowSelected(): void {
    if (listWindowLeaves(this.windowLayout).length === 1) {
      this.splitWindowBelow()
      return
    }
    const otherId = nextEligibleWindowId(
      this.windowLayout,
      this.selectedWindowId,
      1,
      leaf => leaf.id !== this.selectedWindowId && !leaf.dedicated,
    )
    if (otherId) this.selectWindow(otherId)
    else this.splitWindowBelow()
  }

  currentWindowConfiguration(): Extract<RegisterContents, { kind: "window-configuration" }> {
    this.persistSelectedWindowPoint()
    return {
      kind: "window-configuration",
      layout: cloneWindowNode(this.windowLayout),
      selectedWindowId: this.selectedWindowId,
      currentBufferId: this.currentBufferId,
    }
  }

  restoreWindowConfiguration(config: Extract<RegisterContents, { kind: "window-configuration" }>): void {
    this.persistSelectedWindowPoint()
    this.windowLayout = cloneWindowNode(config.layout)
    this.selectedWindowId = config.selectedWindowId
    this.currentBufferId = config.currentBufferId
    if (!findWindowLeaf(this.windowLayout, this.selectedWindowId)) {
      this.selectedWindowId = listWindowLeaves(this.windowLayout)[0]!.id
      this.currentBufferId = findWindowLeaf(this.windowLayout, this.selectedWindowId)!.bufferId
    }
    this.restoreSelectedWindowPoint()
  }

  setSelectedWindowDedicated(dedicated: boolean): void {
    this.windowLayout = setWindowLeafDedicated(this.windowLayout, this.selectedWindowId, dedicated)
    void this.changed("set-window-dedicated")
  }

  scrollOtherWindow(delta = 1): boolean {
    const leaves = listWindowLeaves(this.windowLayout)
    if (leaves.length <= 1) return false
    const otherId = nextWindowId(this.windowLayout, this.selectedWindowId, 1)
    const leaf = findWindowLeaf(this.windowLayout, otherId)
    if (!leaf) return false
    const buffer = this.buffers.get(leaf.bufferId)
    const lineCount = buffer ? buffer.text.split("\n").length : 1
    const maxStart = Math.max(0, lineCount - 1)
    const lines = pageScrollLines() * delta
    this.windowLayout = scrollWindowLeaf(this.windowLayout, otherId, lines, maxStart)
    void this.changed("scroll-other-window")
    return true
  }

  displayBufferInOtherWindow(idOrName: string): BufferModel {
    const found = this.buffers.get(idOrName) ?? [...this.buffers.values()].find(b => b.name === idOrName)
    if (!found) throw new Error(`No such buffer: ${idOrName}`)
    const existing = findWindowShowingBuffer(this.windowLayout, found.id, this.selectedWindowId)
    if (existing) {
      this.selectWindow(existing.id)
      return found
    }
    const reusable = pickReusableWindow(this.windowLayout, this.selectedWindowId)
    if (reusable) {
      this.selectWindow(reusable.id)
    } else {
      const otherId = nextEligibleWindowId(this.windowLayout, this.selectedWindowId, 1, leaf => leaf.id !== this.selectedWindowId && !leaf.dedicated)
      if (otherId) this.selectWindow(otherId)
      else this.ensureOtherWindowSelected()
    }
    this.setSelectedWindowBuffer(found.id)
    if (found.name.startsWith("*") && found.name.endsWith("*")) {
      this.setSelectedWindowDedicated(true)
    }
    return found
  }

  private restoreSelectedWindowPoint(): void {
    const leaf = this.selectedWindowLeaf()
    if (!leaf) return
    const buffer = this.buffers.get(leaf.bufferId)
    if (!buffer) return
    buffer.point = Math.min(leaf.point, buffer.text.length)
  }

  private setSelectedWindowBuffer(bufferId: string): void {
    this.persistSelectedWindowPoint()
    this.currentBufferId = bufferId
    this.windowLayout = setWindowLeafBuffer(this.windowLayout, this.selectedWindowId, bufferId, this.buffers.get(bufferId)?.point ?? 0)
    this.restoreSelectedWindowPoint()
  }

  get currentBuffer(): BufferModel {
    return this.buffers.get(this.currentBufferId) ?? [...this.buffers.values()][0]!
  }

  get activeBuffer(): BufferModel {
    if (!this.minibuffer) return this.currentBuffer
    return this.buffers.get(this.minibuffer.bufferId) ?? this.currentBuffer
  }

  get minibufferDepthLevel(): number {
    return this.minibufferDepth
  }

  addBuffer(buffer: BufferModel): BufferModel {
    this.buffers.set(buffer.id, buffer)
    this.uniquifyBufferNames()
    return buffer
  }

  /** Uniquified name for header/mode-line and C-x b — `buffer.name` plus a `<dir>` suffix when basenames collide. */
  bufferDisplayName(bufferOrId: BufferModel | string): string {
    const buffer = typeof bufferOrId === "string" ? this.buffers.get(bufferOrId) : bufferOrId
    if (!buffer) return typeof bufferOrId === "string" ? bufferOrId : ""
    return this.displayNames.get(buffer.id) ?? buffer.name
  }

  private uniquifyBufferNames(): void {
    this.displayNames.clear()
    const groups = new Map<string, BufferModel[]>()
    for (const buffer of this.buffers.values()) {
      if (buffer.kind === "minibuffer") continue
      const list = groups.get(buffer.name) ?? []
      list.push(buffer)
      groups.set(buffer.name, list)
    }
    for (const [name, members] of groups) {
      if (members.length === 1) {
        this.displayNames.set(members[0]!.id, name)
        continue
      }
      // post-forward-angle-brackets: append the fewest parent dir segments that disambiguate the group.
      const segments = members.map(b => b.path ? dirname(b.path).split(sep).filter(Boolean) : [])
      const maxDepth = Math.max(1, ...segments.map(s => s.length))
      let depth = 1
      let suffixes: string[]
      for (;;) {
        suffixes = segments.map(s => s.slice(-depth).join("/"))
        const distinct = new Set(suffixes.map((s, i) => s || `#${i}`))
        if (distinct.size === members.length || depth >= maxDepth) break
        depth++
      }
      let ordinal = 2
      members.forEach((b, i) => {
        const suffix = suffixes[i]! || String(ordinal++)
        this.displayNames.set(b.id, `${name}<${suffix}>`)
      })
    }
  }

  switchToBuffer(idOrName: string): BufferModel {
    const found = this.buffers.get(idOrName)
      ?? [...this.buffers.values()].find(b => b.name === idOrName || this.displayNames.get(b.id) === idOrName)
      ?? this.addBuffer(new BufferModel({ name: idOrName }))
    this.setSelectedWindowBuffer(found.id)
    if (this.tabs[this.selectedTab]) this.tabs[this.selectedTab]!.bufferId = found.id
    void this.changed("switch-buffer")
    return found
  }

  previousBuffer(): BufferModel {
    const values = [...this.buffers.values()].filter(b => b.kind !== "minibuffer")
    const i = values.findIndex(b => b.id === this.currentBufferId)
    const previous = values[(i - 1 + values.length) % values.length]!
    this.setSelectedWindowBuffer(previous.id)
    if (this.tabs[this.selectedTab]) this.tabs[this.selectedTab]!.bufferId = previous.id
    void this.changed("previous-buffer")
    return previous
  }

  async openFile(path: string): Promise<BufferModel> {
    const full = resolve(path)
    const existing = [...this.buffers.values()].find(b => b.path === full)
    if (existing) return this.switchToBuffer(existing.id)
    const info = await stat(full).catch(() => null)
    if (info?.isDirectory()) return this.openDirectory(full)
    const buffer = await BufferModel.fromFile(full)
    this.addBuffer(buffer)
    this.lsp?.attachBuffer(buffer)
    this.setSelectedWindowBuffer(buffer.id)
    if (this.tabs[this.selectedTab]) this.tabs[this.selectedTab]!.bufferId = buffer.id
    this.enterMode(buffer, buffer.mode)
    await this.changed("open-file")
    await this.runHook("find-file-hook", buffer)
    const autoSave = this.autoSavePath(buffer)
    if (autoSave && await fileExists(autoSave)) {
      const autoMtime = (await stat(autoSave).catch(() => null))?.mtimeMs ?? 0
      if (!info || autoMtime > info.mtimeMs) {
        this.message(`${this.bufferDisplayName(buffer)} has auto save data; consider M-x recover-this-file`)
      }
    }
    return buffer
  }

  async openDirectory(path: string): Promise<BufferModel> {
    const full = resolve(path)
    const existing = [...this.buffers.values()].find(b => b.path === full && b.kind === "directory")
    if (existing) return this.switchToBuffer(existing.id)
    const buffer = await makeDiredBuffer(full)
    this.addBuffer(buffer)
    this.setSelectedWindowBuffer(buffer.id)
    if (this.tabs[this.selectedTab]) this.tabs[this.selectedTab]!.bufferId = buffer.id
    this.enterMode(buffer, "dired")
    await this.changed("open-directory")
    return buffer
  }

  scratch(name: string, text = "", mode = "text"): BufferModel {
    const existing = [...this.buffers.values()].find(b => b.name === name)
    if (existing) {
      existing.setText(text, false)
      existing.kind = name === "*messages*" ? "messages" : "scratch"
      this.enterMode(existing, mode)
      this.setSelectedWindowBuffer(existing.id)
      if (this.tabs[this.selectedTab]) this.tabs[this.selectedTab]!.bufferId = existing.id
      void this.changed("scratch-update")
      return existing
    }
    const buffer = new BufferModel({ name, text, kind: "scratch", mode })
    this.addBuffer(buffer)
    this.enterMode(buffer, mode)
    this.setSelectedWindowBuffer(buffer.id)
    if (this.tabs[this.selectedTab]) this.tabs[this.selectedTab]!.bufferId = buffer.id
    void this.changed("scratch")
    return buffer
  }

  async runHook(name: string, buffer: BufferModel): Promise<void> {
    await runHooks(name, { editor: this, buffer })
  }

  enterMode(buffer: BufferModel, modeName: string): void {
    const resolved = getMode(modeName) ? modeName : "text"
    enterMode(buffer, resolved)
    void this.runHook(modeHookName(resolved), buffer)
  }

  command(name: string, fn: CommandFn, description?: string): void {
    this.commands.define(name, fn, { description, interactive: true })
  }

  /** @deprecated Use `defineKey("global-map", sequence, commandName)`. */
  key(sequence: string, commandName: string): void {
    this.defineKey("global-map", sequence, commandName)
  }

  defineKey(mapName: "global" | "minibuffer" | string, sequence: string, commandName: string, source?: SourceLocation): void {
    const map = canonicalMapName(mapName)
    if (map === "global-map") this.keymap.bind(sequence, commandName)
    else if (map === "minibuffer-local-map") this.minibufferKeymap.bind(sequence, commandName)
    else {
      const base = map.slice(0, -4) // strip canonical "-map" suffix for mode lookup
      const mode = getMode(base)
      const minor = mode ? undefined : getMinorMode(base)
      const target = mode?.keymap ?? minor?.keymap
      if (!target) throw new Error(`Unknown keymap: ${mapName}`)
      target.bind(sequence, commandName)
    }
    registerKeyBinding(map, sequence, commandName, source)
  }

  isMinorModeEnabled(name: string, buffer: BufferModel = this.currentBuffer): boolean {
    const mode = getMinorMode(name)
    if (!mode) return false
    if (this.globalMinorModes.has(name)) return true
    return buffer.minorModes.has(name)
  }

  activeMinorModes(buffer: BufferModel = this.currentBuffer): MinorMode[] {
    return allMinorModes().filter(mode => this.isMinorModeEnabled(mode.name, buffer))
  }

  minorModeLighters(buffer: BufferModel = this.currentBuffer): string {
    return this.activeMinorModes(buffer).map(mode => mode.lighter ?? ` ${mode.name}`).join("")
  }

  enableMinorMode(name: string, options: { buffer?: BufferModel } = {}): void {
    const mode = getMinorMode(name)
    if (!mode) throw new Error(`Unknown minor mode: ${name}`)
    const buffer = options.buffer ?? this.currentBuffer
    if (mode.global) this.globalMinorModes.add(name)
    else buffer.minorModes.add(name)
    mode.onEnable?.(this, buffer)
    void this.changed(`minor-mode-enable:${name}`)
  }

  disableMinorMode(name: string, options: { buffer?: BufferModel } = {}): void {
    const mode = getMinorMode(name)
    if (!mode) throw new Error(`Unknown minor mode: ${name}`)
    const buffer = options.buffer ?? this.currentBuffer
    if (mode.global) this.globalMinorModes.delete(name)
    else buffer.minorModes.delete(name)
    mode.onDisable?.(this, buffer)
    void this.changed(`minor-mode-disable:${name}`)
  }

  toggleMinorMode(name: string, options: { buffer?: BufferModel } = {}): boolean {
    const buffer = options.buffer ?? this.currentBuffer
    if (this.isMinorModeEnabled(name, buffer)) {
      this.disableMinorMode(name, options)
      return false
    }
    this.enableMinorMode(name, options)
    return true
  }

  async run(name: string, args: string[] = [], keyEvent: KeyEventLike | null = null): Promise<unknown> {
    const spec = this.commands.get(name)
    if (!spec) {
      // kbd-macro replay: a recorded literal char dispatches as self-insert.
      if (name.length === 1 && this.commands.get("self-insert-command")) {
        this.lastKeyEvent = { name, sequence: name }
        return this.run("self-insert-command", [name], this.lastKeyEvent)
      }
      throw new Error(`Unknown command: ${name}`)
    }
    const buildsPrefix = name === "universal-argument" || name === "negative-argument" || name === "digit-argument"
    const prefixArgument = buildsPrefix ? null : this.consumePrefixArgument()
    let runArgs = args
    if (typeof spec.interactive === "string" && !runArgs.length) {
      runArgs = await readInteractiveArgs(this, spec.interactive)
    }
    this.thisCommand = name
    const ctx = { editor: this, buffer: this.activeBuffer, args: runArgs, prefixArgument, keyEvent }
    const result = await invokeWithAdvice(name, spec.fn, ctx)
    await this.runHook("post-command-hook", this.activeBuffer)
    await this.changed(`command:${name}`)
    return result
  }

  async handleKey(key: KeyEventLike): Promise<KeyDispatchResult> {
    const result = await this.dispatchKey(key)
    if ((result.status === "command" || result.status === "inserted")
      && ++this.autoSaveKeystrokes >= (getCustom<number>("auto-save-keystroke-interval") ?? 300)) {
      void this.doAutoSave()
    }
    return result
  }

  private async dispatchKey(key: KeyEventLike): Promise<KeyDispatchResult> {
    this.lastKeyEvent = key

    if (this.isearch) {
      const isearchResult = await this.handleIsearchKey(key)
      if (isearchResult) return isearchResult
    }

    const digit = digitFromKey(key.name)
    if (digit != null && this.prefixArg.acceptsDigitKey()) {
      await this.run("digit-argument", [String(digit)])
      return { status: "command", command: "digit-argument" }
    }

    const fed = this.keymaps.feed(key)
    if (fed.status === "matched") {
      const wasRecording = this.macroRecording
      const isearchBefore = this.isearch
      try {
        await this.run(fed.command, [], key)
      } finally {
        // A non-isearch command pressed during isearch ends the search; isearch-* commands
        // manage state themselves and keyboard-quit cancels it, so only end if untouched.
        if (isearchBefore && this.isearch === isearchBefore && !fed.command.startsWith("isearch")) {
          this.endIsearch()
        }
      }
      if (wasRecording && this.macroRecording) this.macroRecording.push(fed.command)
      return { status: "command", command: fed.command }
    }

    if (fed.status === "pending") {
      await this.changed("key-prefix")
      return { status: "pending" }
    }

    if (this.commands.get("self-insert-command") && (isPrintable(key) || this.quotedInsertNext)) {
      await this.run("self-insert-command", key.sequence ? [key.sequence] : [], key)
      if (this.macroRecording && key.sequence) this.macroRecording.push(key.sequence)
      return { status: "command", command: "self-insert-command" }
    }

    const token = keyToken(key)
    const detail = key.raw && key.raw !== key.sequence ? ` (${key.raw.replace(/\x1b/g, "ESC")})` : ""
    this.message(`Unbound key: ${token}${detail}`)
    return { status: "unmatched" }
  }

  async prompt(
    prompt: string,
    initialValue = "",
    historyName?: string,
    options: { collection?: string[]; completion?: "file"; defaultDirectory?: string } = {},
  ): Promise<string | null> {
    const previous = this.minibuffer
    return await new Promise((resolve, reject) => {
      const depth = ++this.minibufferDepth
      const buffer = new BufferModel({ name: ` *Minibuffer-${depth}*`, text: initialValue, kind: "minibuffer", mode: "minibuffer" })
      const cleanup = () => {
        this.buffers.delete(buffer.id)
        this.minibuffer = previous
        this.minibufferCompletionDisplay = null
        this.minibufferDepth--
      }
      try {
        buffer.point = buffer.text.length
        this.addBuffer(buffer)
        this.enterMode(buffer, "minibuffer")
        this.minibuffer = {
          prompt,
          bufferId: buffer.id,
          historyName,
          historyIndex: null,
          collection: options.collection,
          completion: options.completion,
          fileCompletionDirectory: options.completion === "file"
            ? (options.defaultDirectory ?? this.currentBuffer.directory() ?? process.cwd())
            : undefined,
          resolve: value => { cleanup(); resolve(value) },
        }
        void this.events.emit("minibuffer", { prompt })
        void this.changed("minibuffer-open")
      } catch (err) {
        cleanup()
        reject(err)
      }
    })
  }

  completingRead(prompt: string, options: CompletingReadOptions): Promise<string | null> {
    if (this.completingReadFunction) return this.completingReadFunction(this, prompt, options)
    return this.prompt(prompt, options.initialValue ?? "", options.history, {
      collection: options.collection,
      completion: options.completion,
      defaultDirectory: options.defaultDirectory,
    })
  }

  indentLine(buffer = this.activeBuffer): void {
    const indent = modeFeature(buffer.mode, "indentLine")
    if (indent) indent(buffer)
    else buffer.insert("  ")
    void this.changed("indent-line")
  }

  async completeAtPoint(buffer = this.activeBuffer): Promise<boolean> {
    const lspCandidates = await this.lsp?.completionAtPoint(buffer) ?? []
    if (lspCandidates.length) return this.applyCompletionCandidates(buffer, lspCandidates)

    const complete = modeFeature(buffer.mode, "completeAtPoint")
    const candidates = complete?.(buffer) ?? []
    if (!candidates.length) return false
    return this.applyCompletionCandidates(buffer, candidates)
  }

  private applyCompletionCandidates(buffer: BufferModel, candidates: CompletionCandidate[]): boolean {
    if (!candidates.length) return false
    const symbol = buffer.symbolBoundsAt()
    const texts = candidates.map(candidate => candidate.text)
    const common = commonPrefix(texts)
    const replacement = common.length > symbol.text.length ? common : candidates[0]!.text
    buffer.replaceRange(candidates[0]!.start, candidates[0]!.end, replacement)
    if (candidates.length > 1) {
      const existing = [...this.buffers.values()].find(b => b.name === "*Completions*")
      const body = texts.join("\n")
      if (existing) existing.setText(body, false)
      else this.addBuffer(new BufferModel({ name: "*Completions*", text: body, kind: "scratch", mode: "text" }))
    }
    void this.changed("completion-at-point")
    return true
  }

  fontLock(buffer = this.currentBuffer): TextSpan[] {
    const fontLock = modeFeature(buffer.mode, "fontLock")
    const cached = this.fontLockCache.get(buffer)
    let spans: TextSpan[]
    if (cached && cached.text === buffer.text) spans = cached.spans
    else {
      spans = fontLock?.(buffer) ?? []
      this.fontLockCache.set(buffer, { text: buffer.text, spans })
    }
    const lspSpans = this.lsp?.diagnosticSpans(buffer) ?? []
    const overlaySpans = this.overlaySources.flatMap(src => src(buffer))
    if (!lspSpans.length && !overlaySpans.length) return spans
    return [...spans, ...lspSpans, ...overlaySpans]
  }

  /** Register a span producer consulted on every render (minor-mode overlays
   *  like smerge/show-paren) — kept out of the text-keyed font-lock cache. */
  addOverlaySource(fn: (buffer: BufferModel) => TextSpan[]): void {
    this.overlaySources.push(fn)
  }

  setTheme(theme: Theme): void {
    this.theme = theme
    void this.changed("theme")
  }

  splitWindowBelow(): void {
    this.persistSelectedWindowPoint()
    const buffer = this.currentBuffer
    const startLine = this.lineAtPoint(buffer.point)
    const result = splitWindowLeaf(this.windowLayout, this.selectedWindowId, "vertical", buffer.id, buffer.point)
    this.windowLayout = setWindowLeafStartLine(result.layout, result.newWindowId, startLine)
    this.selectedWindowId = result.newWindowId
    this.restoreSelectedWindowPoint()
    void this.changed("split-window-below")
  }

  splitWindowRight(): void {
    this.persistSelectedWindowPoint()
    const buffer = this.currentBuffer
    const startLine = this.lineAtPoint(buffer.point)
    const result = splitWindowLeaf(this.windowLayout, this.selectedWindowId, "horizontal", buffer.id, buffer.point)
    this.windowLayout = setWindowLeafStartLine(result.layout, result.newWindowId, startLine)
    this.selectedWindowId = result.newWindowId
    this.restoreSelectedWindowPoint()
    void this.changed("split-window-right")
  }

  deleteOtherWindows(): void {
    if (listWindowLeaves(this.windowLayout).length <= 1) return
    this.persistSelectedWindowPoint()
    this.windowLayout = deleteOtherWindowLeaves(this.windowLayout, this.selectedWindowId)
    this.restoreSelectedWindowPoint()
    void this.changed("delete-other-windows")
  }

  killBuffer(idOrName?: string): BufferModel | null {
    const target = idOrName
      ? this.buffers.get(idOrName)
        ?? [...this.buffers.values()].find(b => b.name === idOrName || this.displayNames.get(b.id) === idOrName)
      : this.currentBuffer
    if (!target || target.kind === "minibuffer") return null
    const survivors = [...this.buffers.values()].filter(b => b.kind !== "minibuffer" && b.id !== target.id)
    if (!survivors.length) {
      this.message("Cannot kill the only buffer")
      return null
    }
    const survivorIds = new Set(survivors.map(b => b.id))
    const fallbackId = this.bufferRecency.find(id => survivorIds.has(id)) ?? survivors[0]!.id
    this.buffers.delete(target.id)
    const ri = this.bufferRecency.indexOf(target.id)
    if (ri !== -1) this.bufferRecency.splice(ri, 1)
    this.uniquifyBufferNames()
    this.windowLayout = removeBufferFromWindows(this.windowLayout, target.id, fallbackId)
    if (findWindowLeaf(this.windowLayout, this.selectedWindowId) == null) {
      this.selectedWindowId = listWindowLeaves(this.windowLayout)[0]!.id
    }
    this.tabs.forEach(tab => {
      if (tab.bufferId === target.id) tab.bufferId = fallbackId
    })
    if (this.currentBufferId === target.id) this.switchToBuffer(fallbackId)
    void this.changed("kill-buffer")
    return target
  }

  /** `#basename#` sibling path for a file-visiting buffer's auto-save data. */
  autoSavePath(buffer: BufferModel): string | null {
    if (!buffer.path || buffer.kind !== "file") return null
    return resolve(dirname(buffer.path), `#${basename(buffer.path)}#`)
  }

  startAutoSave(): void {
    if (this.autoSaveTimer) return
    const seconds = getCustom<number>("auto-save-interval") ?? 30
    this.autoSaveTimer = setInterval(() => void this.doAutoSave(), seconds * 1000)
  }

  stopAutoSave(): void {
    if (this.autoSaveTimer) clearInterval(this.autoSaveTimer)
    this.autoSaveTimer = null
  }

  /** Write `#file#` for every dirty file-visiting buffer; called by timer and keystroke threshold. */
  async doAutoSave(): Promise<number> {
    this.autoSaveKeystrokes = 0
    let written = 0
    for (const buffer of this.buffers.values()) {
      if (!buffer.dirty) continue
      const target = this.autoSavePath(buffer)
      if (!target) continue
      try {
        await writeFileText(target, buffer.text)
        written++
      } catch (err) {
        this.message(`Auto-save failed for ${this.bufferDisplayName(buffer)}: ${(err as Error).message}`)
      }
    }
    if (written) await this.runHook("auto-save-hook", this.currentBuffer)
    return written
  }

  async deleteAutoSaveFile(buffer: BufferModel): Promise<void> {
    const target = this.autoSavePath(buffer)
    if (!target) return
    await unlink(target).catch(() => {})
  }

  /** If `#file#` exists and is newer than `file`, offer to replace buffer text from it. */
  async recoverThisFile(buffer: BufferModel = this.currentBuffer): Promise<boolean> {
    const target = this.autoSavePath(buffer)
    if (!target || !buffer.path) {
      this.message("Buffer is not visiting a file")
      return false
    }
    if (!(await fileExists(target))) {
      this.message(`No auto-save file ${target}`)
      return false
    }
    const [autoStat, fileStat] = await Promise.all([stat(target), stat(buffer.path).catch(() => null)])
    if (fileStat && autoStat.mtimeMs <= fileStat.mtimeMs) {
      this.message("Auto-save file is not newer; not recovering")
      return false
    }
    const answer = await this.prompt(`Recover from ${basename(target)}? (y or n) `)
    if (!answer || !/^y/i.test(answer)) return false
    const recovered = await readFileText(target)
    buffer.setText(recovered, true)
    this.message(`Recovered ${this.bufferDisplayName(buffer)} from auto-save file`)
    return true
  }

  recenterTopBottom(): void {
    const leaf = this.selectedWindowLeaf()
    if (!leaf) return
    const buffer = this.currentBuffer
    const page = pageScrollLines()
    const lineIdx = buffer.lineCol().line - 1
    const targetStart =
      this.recenterCycle === 0 ? Math.max(0, lineIdx - Math.floor(page / 2))
      : this.recenterCycle === 1 ? lineIdx
      : Math.max(0, lineIdx - page + 1)
    this.windowLayout = setWindowLeafStartLine(this.windowLayout, leaf.id, targetStart)
    this.recenterCycle = (this.recenterCycle + 1) % 3
    void this.changed("recenter-top-bottom")
  }

  deleteWindow(): void {
    if (listWindowLeaves(this.windowLayout).length <= 1) return
    this.persistSelectedWindowPoint()
    const next = nextWindowId(this.windowLayout, this.selectedWindowId, 1)
    const layout = deleteWindowLeaf(this.windowLayout, this.selectedWindowId)
    if (!layout) return
    this.windowLayout = layout
    this.selectedWindowId = findWindowLeaf(layout, next) ? next : listWindowLeaves(layout)[0]!.id
    this.currentBufferId = findWindowLeaf(this.windowLayout, this.selectedWindowId)!.bufferId
    this.restoreSelectedWindowPoint()
    void this.changed("delete-window")
  }

  private consumePrefixArgument(): number | null {
    return this.prefixArg.consume()
  }

  startIsearch(direction: 1 | -1): void {
    const buffer = this.activeBuffer
    this.isearch = { bufferId: buffer.id, string: "", direction, startPoint: buffer.point }
    this.message(direction === 1 ? "Isearch forward" : "Isearch backward")
    void this.changed("isearch-start")
  }

  isearchRepeat(): void {
    const state = this.isearch
    if (!state) return
    if (!state.string) {
      const last = this.searchRing.at(-1)
      if (!last) return
      this.setIsearchString(last)
      return
    }
    const buffer = this.buffers.get(state.bufferId)
    if (!buffer) return
    const from = state.direction === 1 ? buffer.point + 1 : buffer.point - 1
    const match = state.direction === 1
      ? findForward(buffer.text, state.string, from)
      : findBackward(buffer.text, state.string, from)
    if (match == null) {
      this.message(`Search failed: ${state.string}`)
      return
    }
    buffer.point = match
    this.message(isearchPrompt(state))
    void this.changed("isearch-repeat")
  }

  cancelIsearch(): void {
    if (!this.isearch) return
    const buffer = this.buffers.get(this.isearch.bufferId)
    if (buffer) buffer.point = this.isearch.startPoint
    this.isearch = null
    void this.changed("isearch-cancel")
  }

  endIsearch(): void {
    if (!this.isearch) return
    const s = this.isearch.string
    if (s && this.searchRing.at(-1) !== s) this.searchRing.push(s)
    this.isearch = null
    void this.changed("isearch-end")
  }

  private setIsearchString(string: string): void {
    const state = this.isearch
    if (!state) return
    const buffer = this.buffers.get(state.bufferId)
    if (!buffer) return
    state.string = string
    if (!string) {
      buffer.point = state.startPoint
      this.message(isearchPrompt(state))
      void this.changed("isearch-input")
      return
    }
    const from = state.direction === 1 ? state.startPoint : state.startPoint
    const match = state.direction === 1
      ? findForward(buffer.text, string, from, state.regexp ?? false)
      : findBackward(buffer.text, string, from, state.regexp ?? false)
    if (match == null) {
      this.message(`Failing I-search: ${string}`)
      void this.changed("isearch-fail")
      return
    }
    buffer.point = match
    this.message(isearchPrompt(state))
    void this.changed("isearch-input")
  }

  private async handleIsearchKey(key: KeyEventLike): Promise<KeyDispatchResult | null> {
    const state = this.isearch
    if (state && key.ctrl && !key.meta && key.name === "w") {
      const buffer = this.buffers.get(state.bufferId)
      if (buffer) {
        const from = buffer.point + (state.direction === 1 ? state.string.length : 0)
        const m = /^\W?\w*/.exec(buffer.text.slice(from))
        if (m && m[0]) this.setIsearchString(state.string + m[0])
      }
      return { status: "inserted" }
    }
    switch (key.name) {
      case "backspace":
        if (this.isearch) this.setIsearchString(this.isearch.string.slice(0, -1))
        return { status: "inserted" }
      case "return":
        this.endIsearch()
        return { status: "inserted" }
      case "delete":
        return { status: "inserted" }
      default:
        if (isPrintable(key)) {
          const text = (key.sequence ?? "").repeat(this.consumePrefixArgument() ?? 1)
          if (this.isearch) this.setIsearchString(this.isearch.string + text)
          return { status: "inserted" }
        }
    }
    return null
  }

  async minibufferInsert(s: string): Promise<void> {
    if (!this.minibuffer) return
    this.activeBuffer.insert(s)
    await this.refreshMinibufferCompletions()
    await this.changed("minibuffer-input")
  }

  /** User-typed portion of the minibuffer, excluding any completion overlay appended after the first newline.
   *  For file-name reads an embedded `//` or `/~` restarts the path (substitute-in-file-name), so candidate
   *  generation and matching see the same string find-file will open — otherwise fido shows [No match]. */
  minibufferInput(): string {
    if (!this.minibuffer) return ""
    const text = this.activeBuffer.text
    const nl = text.indexOf("\n")
    const raw = nl === -1 ? text : text.slice(0, nl)
    if (this.minibuffer.completion !== "file") return raw
    const restart = Math.max(raw.lastIndexOf("//"), raw.lastIndexOf("/~"))
    return restart >= 0 ? raw.slice(restart + 1) : raw
  }

  /** Replace the inline completion overlay (text after the first newline). Point stays inside the input. */
  setMinibufferOverlay(overlay: string): void {
    if (!this.minibuffer) return
    const buffer = this.activeBuffer
    const input = this.minibufferInput()
    const point = Math.min(buffer.point, input.length)
    buffer.setText(overlay ? `${input}\n${overlay}` : input, false)
    buffer.point = point
    void this.changed("minibuffer-overlay")
  }

  /** Resolve the active minibuffer with an explicit value (used when accepting a highlighted candidate). */
  minibufferAccept(value: string): void {
    const request = this.minibuffer
    if (!request) return
    if (request.historyName && value) {
      const history = this.minibufferHistory.get(request.historyName) ?? []
      history.push(value)
      this.minibufferHistory.set(request.historyName, history)
    }
    request.resolve(value)
    void this.changed("minibuffer-submit")
  }

  async minibufferCollection(): Promise<string[]> {
    const request = this.minibuffer
    if (!request) return []
    if (request.completion === "file") {
      return fileCompletionCandidates(this.minibufferInput(), request.fileCompletionDirectory ?? process.cwd())
    }
    return request.collection ?? []
  }

  /** Incremental completion (icomplete-style) while typing in the minibuffer. */
  async refreshMinibufferCompletions(): Promise<void> {
    const request = this.minibuffer
    if (!request) return
    if (this.minibufferCompletionFrontend?.refresh) {
      await this.minibufferCompletionFrontend.refresh(this)
      return
    }
    const collection = request.collection
    if (!collection?.length) return
    const text = this.minibufferInput()
    const matches = this.completer
      ? this.completer(text, collection)
      : collection.filter(item => item.startsWith(text))
    if (matches.length > 1) this.showCompletions(matches)
  }

  async minibufferBackspace(): Promise<void> {
    if (!this.minibuffer) return
    this.activeBuffer.deleteBackward()
    await this.refreshMinibufferCompletions()
    await this.changed("minibuffer-backspace")
  }

  minibufferSubmit(): void {
    if (!this.minibuffer) return
    const request = this.minibuffer
    const value = this.minibufferCompletionFrontend?.submitValue?.(this) ?? this.minibufferInput()
    if (request.historyName && value) {
      const history = this.minibufferHistory.get(request.historyName) ?? []
      history.push(value)
      this.minibufferHistory.set(request.historyName, history)
    }
    request.resolve(value)
    this.minibufferCompletionDisplay = null
    void this.changed("minibuffer-submit")
  }

  minibufferCancel(): void {
    if (!this.minibuffer) return
    const request = this.minibuffer
    request.resolve(null)
    this.minibufferCompletionDisplay = null
    void this.changed("minibuffer-cancel")
  }

  async minibufferComplete(): Promise<void> {
    const request = this.minibuffer
    if (!request) return
    if (this.minibufferCompletionFrontend?.complete) {
      await this.minibufferCompletionFrontend.complete(this)
      return
    }
    const input = this.minibufferInput()
    const collection = request.completion === "file"
      ? await fileCompletionCandidates(input, request.fileCompletionDirectory ?? process.cwd())
      : request.collection ?? []
    if (!collection.length) return

    const matches = this.completer
      ? this.completer(input, collection)
      : collection.filter(item => item.startsWith(input))
    if (matches.length === 1) {
      this.setMinibufferText(matches[0]!, matches[0]!.length)
      return
    }
    if (matches.length > 1) {
      const common = commonPrefix(matches)
      if (common.length > input.length) {
        this.setMinibufferText(common, common.length)
      }
      this.showCompletions(matches)
    }
  }

  private setMinibufferText(text: string, point: number): void {
    const buffer = this.activeBuffer
    buffer.setText(text, true)
    buffer.point = point
    void this.changed("minibuffer-input")
  }

  private showCompletions(matches: string[]): void {
    this.minibufferCompletionDisplay = { text: matches.join("\n") }
    const existing = [...this.buffers.values()].find(b => b.name === "*Completions*")
    const body = matches.join("\n")
    if (existing) existing.setText(body, false)
    else this.addBuffer(new BufferModel({ name: "*Completions*", text: body, kind: "scratch", mode: "text" }))
    void this.changed("minibuffer-complete")
  }

  async minibufferPreviousHistory(): Promise<void> {
    const request = this.minibuffer
    if (!request?.historyName) return
    const history = this.minibufferHistory.get(request.historyName) ?? []
    if (!history.length) return
    request.historyIndex = request.historyIndex == null ? history.length - 1 : Math.max(0, request.historyIndex - 1)
    this.activeBuffer.setText(history[request.historyIndex]!, true)
    this.activeBuffer.point = this.activeBuffer.text.length
  }

  async minibufferNextHistory(): Promise<void> {
    const request = this.minibuffer
    if (!request?.historyName || request.historyIndex == null) return
    const history = this.minibufferHistory.get(request.historyName) ?? []
    request.historyIndex = Math.min(history.length - 1, request.historyIndex + 1)
    this.activeBuffer.setText(history[request.historyIndex] ?? "", true)
    this.activeBuffer.point = this.activeBuffer.text.length
  }

  describeKey(sequence: string): string {
    const described = this.keymaps.describe(sequence)
    if (!described) return `${sequence} is undefined`
    const command = this.commands.get(described.command)
    const description = command?.description ? ` — ${command.description}` : ""
    return `${described.sequence} runs ${described.command} from ${described.mapName}${description}`
  }

  message(text: string): string {
    const msg = [...this.buffers.values()].find(b => b.name === "*messages*")
    if (msg) {
      msg.append(`${new Date().toISOString()}  ${text}\n`)
      msg.point = msg.text.length
    }
    void this.events.emit("message", { text })
    void this.changed("message")
    return text
  }

  async changed(reason: string): Promise<void> {
    await this.events.emit("changed", { reason })
  }

  quit(): void {
    this.running = false
    this.stopAutoSave()
    void this.changed("quit")
  }

  private activeKeymaps(): Array<{ name: string; keymap: Keymap }> {
    const maps: Array<{ name: string; keymap: Keymap }> = []
    if (this.overridingTerminalLocalMap) maps.push({ name: "overriding-terminal-local-map", keymap: this.overridingTerminalLocalMap })
    if (this.overridingMap) maps.push({ name: "overriding-map", keymap: this.overridingMap })
    if (this.minibuffer) {
      const frontendMap = this.minibufferCompletionFrontend?.keymap
      if (frontendMap) maps.push({ name: frontendMap.name, keymap: frontendMap })
      maps.push({ name: "minibuffer-local-map", keymap: this.minibufferKeymap })
      maps.push({ name: "global-map", keymap: this.keymap })
      return maps
    }
    for (const mode of this.activeMinorModes()) {
      if (mode.keymap) maps.push({ name: `${mode.name}-map`, keymap: mode.keymap })
    }
    for (const mode of modeLineage(this.currentBuffer.mode)) {
      if (mode.keymap) maps.push({ name: `${mode.name}-map`, keymap: mode.keymap })
    }
    maps.push({ name: "global-map", keymap: this.keymap })
    return maps
  }
}

function commonPrefix(values: string[]): string {
  if (!values.length) return ""
  let prefix = values[0]!
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  return prefix
}
