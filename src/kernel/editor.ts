import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { BufferModel } from "./buffer"
import { CommandRegistry, type CommandFn } from "./command"
import { Emitter } from "./events"
import { isPrintable, Keymap, KeymapStack, keyToken, type KeyEventLike } from "./keymap"
import { digitFromKey, PrefixArgumentState } from "./prefix-argument"
import { enterMode, getMode, modeFeature, modeLineage, type CompletionCandidate, type TextSpan } from "../modes/mode"
import { allMinorModes, getMinorMode, type MinorMode } from "../modes/minor-mode"
import { makeDiredBuffer } from "../modes/dired"
import { defaultTheme, type Theme } from "../display/theme"
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
import {
  modeHookName,
  addHook as registerHook,
  removeHook as unregisterHook,
  runHooks,
  type HookFn,
} from "./hooks"
import type { LspManager } from "../lsp/manager"

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

export type KeyDispatchResult =
  | { status: "command"; command: string }
  | { status: "pending" }
  | { status: "inserted" }
  | { status: "unmatched" }

export class Editor {
  readonly buffers = new Map<string, BufferModel>()
  private readonly fontLockCache = new WeakMap<BufferModel, { text: string; spans: TextSpan[] }>()
  readonly commands = new CommandRegistry()
  readonly keymap = new Keymap("global-map")
  readonly minibufferKeymap = new Keymap("minibuffer-local-map")
  readonly events = new Emitter<EditorEvents>()
  readonly keymaps = new KeymapStack(() => this.activeKeymaps())
  readonly minibufferHistory = new Map<string, string[]>()
  readonly registers = new Map<string, RegisterContents>()
  readonly tabs: Array<{ name: string; bufferId: string }> = []
  windowLayout: WindowNode
  selectedWindowId: string
  theme: Theme = defaultTheme
  selectedTab = 0
  tilingLayout = "tiling-master-left"
  currentBufferId: string
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
  private minibufferDepth = 0

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

  get windows(): string[] {
    return listWindowLeaves(this.windowLayout).map(leaf => leaf.bufferId)
  }

  get selectedWindow(): number {
    return listWindowLeaves(this.windowLayout).findIndex(leaf => leaf.id === this.selectedWindowId)
  }

  selectedWindowLeaf() {
    return findWindowLeaf(this.windowLayout, this.selectedWindowId)
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

  windowConfigurationToRegister(register: string): void {
    this.registers.set(register, this.currentWindowConfiguration())
    this.message(`Saved window configuration to register ${register}`)
  }

  jumpToRegister(register: string): boolean {
    const value = this.registers.get(register)
    if (!value) return false
    if (value.kind === "point") {
      this.currentBuffer.point = Math.max(0, Math.min(value.point, this.currentBuffer.text.length))
      this.windowLayout = setWindowLeafPoint(this.windowLayout, this.selectedWindowId, this.currentBuffer.point)
      return true
    }
    this.restoreWindowConfiguration(value)
    return true
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
    const lines = Math.max(1, (process.stdout.rows ?? 30) - 6) * delta
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
    return buffer
  }

  switchToBuffer(idOrName: string): BufferModel {
    const found = this.buffers.get(idOrName) ?? [...this.buffers.values()].find(b => b.name === idOrName)
    if (!found) throw new Error(`No such buffer: ${idOrName}`)
    this.setSelectedWindowBuffer(found.id)
    if (this.tabs[this.selectedTab]) this.tabs[this.selectedTab]!.bufferId = found.id
    void this.changed("switch-buffer")
    return found
  }

  nextBuffer(): BufferModel {
    const values = [...this.buffers.values()].filter(b => b.kind !== "minibuffer")
    const i = values.findIndex(b => b.id === this.currentBufferId)
    const next = values[(i + 1) % values.length]!
    this.setSelectedWindowBuffer(next.id)
    if (this.tabs[this.selectedTab]) this.tabs[this.selectedTab]!.bufferId = next.id
    void this.changed("next-buffer")
    return next
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

  /** Register a named hook (`find-file-hook`, `python-mode-hook`, …). */
  addHook(name: string, fn: HookFn): void {
    registerHook(name, fn)
  }

  removeHook(name: string, fn: HookFn): void {
    unregisterHook(name, fn)
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

  key(sequence: string, commandName: string): void {
    this.keymap.bind(sequence, commandName)
  }

  defineKey(mapName: "global" | "minibuffer" | string, sequence: string, commandName: string): void {
    if (mapName === "global" || mapName === "global-map") this.keymap.bind(sequence, commandName)
    else if (mapName === "minibuffer" || mapName === "minibuffer-local-map") this.minibufferKeymap.bind(sequence, commandName)
    else {
      const base = mapName.replace(/-map$/, "")
      const mode = getMode(base)
      if (mode?.keymap) {
        mode.keymap.bind(sequence, commandName)
        return
      }
      const minor = getMinorMode(base)
      if (minor?.keymap) {
        minor.keymap.bind(sequence, commandName)
        return
      }
      throw new Error(`Unknown keymap: ${mapName}`)
    }
  }

  isMinorModeEnabled(name: string, buffer: BufferModel = this.currentBuffer): boolean {
    const mode = getMinorMode(name)
    if (!mode) return false
    if (this.globalMinorModes.has(name)) return true
    return buffer.minorModes.has(name)
  }

  showLineNumbers(buffer: BufferModel = this.currentBuffer): boolean {
    return this.isMinorModeEnabled("linum-mode", buffer)
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

  async run(name: string, args: string[] = []): Promise<unknown> {
    const spec = this.commands.get(name)
    if (!spec) throw new Error(`Unknown command: ${name}`)
    const prefixArgument = name === "universal-argument" ? null : this.consumePrefixArgument()
    const result = await spec.fn({ editor: this, buffer: this.activeBuffer, args, prefixArgument })
    await this.changed(`command:${name}`)
    return result
  }

  async handleKey(key: KeyEventLike): Promise<KeyDispatchResult> {
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
      await this.run(fed.command)
      if (this.macroRecording) this.macroRecording.push(fed.command)
      return { status: "command", command: fed.command }
    }

    if (fed.status === "pending") {
      await this.changed("key-prefix")
      return { status: "pending" }
    }

    if (this.commands.get("self-insert-command") && (isPrintable(key) || this.quotedInsertNext)) {
      await this.run("self-insert-command")
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
    this.minibufferDepth++
    return await new Promise(resolve => {
      const buffer = new BufferModel({ name: ` *Minibuffer-${this.minibufferDepth}*`, text: initialValue, kind: "minibuffer", mode: "minibuffer" })
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
        resolve: value => {
          this.buffers.delete(buffer.id)
          this.minibuffer = previous
          this.minibufferDepth--
          resolve(value)
        },
      }
      void this.events.emit("minibuffer", { prompt })
      void this.changed("minibuffer-open")
    })
  }

  completingRead(prompt: string, options: CompletingReadOptions): Promise<string | null> {
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
    if (!lspSpans.length) return spans
    return [...spans, ...lspSpans]
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
      ? this.buffers.get(idOrName) ?? [...this.buffers.values()].find(b => b.name === idOrName)
      : this.currentBuffer
    if (!target || target.kind === "minibuffer") return null
    const survivors = [...this.buffers.values()].filter(b => b.kind !== "minibuffer" && b.id !== target.id)
    if (!survivors.length) {
      this.message("Cannot kill the only buffer")
      return null
    }
    this.buffers.delete(target.id)
    this.windowLayout = removeBufferFromWindows(this.windowLayout, target.id, survivors[0]!.id)
    if (findWindowLeaf(this.windowLayout, this.selectedWindowId) == null) {
      this.selectedWindowId = listWindowLeaves(this.windowLayout)[0]!.id
    }
    this.tabs.forEach(tab => {
      if (tab.bufferId === target.id) tab.bufferId = survivors[0]!.id
    })
    if (this.currentBufferId === target.id) this.switchToBuffer(survivors[0]!.id)
    void this.changed("kill-buffer")
    return target
  }

  recenterTopBottom(): void {
    const leaf = this.selectedWindowLeaf()
    if (!leaf) return
    const buffer = this.currentBuffer
    const page = Math.max(1, (process.stdout.rows ?? 30) - 6)
    const lineIdx = buffer.lineCol().line - 1
    if (this.recenterCycle === 0) {
      const targetStart = Math.max(0, lineIdx - Math.floor(page / 2))
      this.windowLayout = setWindowLeafStartLine(this.windowLayout, leaf.id, targetStart)
    } else if (this.recenterCycle === 1) {
      buffer.moveToLineStart()
    } else {
      buffer.moveToLineEnd()
    }
    this.recenterCycle = (this.recenterCycle + 1) % 3
    void this.changed("recenter-top-bottom")
  }

  scrollScreen(forward: boolean, screens = 1): void {
    const leaf = this.selectedWindowLeaf()
    if (!leaf) return
    const buffer = this.currentBuffer
    const page = Math.max(1, (process.stdout.rows ?? 30) - 6) * screens
    const lines = buffer.text.split("\n")
    const lineCount = lines.length
    const maxStart = Math.max(0, lineCount - 1)
    const delta = forward ? page : -page
    const newStart = Math.max(0, Math.min(maxStart, leaf.startLine + delta))
    this.windowLayout = setWindowLeafStartLine(this.windowLayout, leaf.id, newStart)
    const { line, col } = buffer.lineCol()
    const targetLine = Math.max(0, Math.min(lineCount - 1, line - 1 + delta))
    let offset = 0
    for (let i = 0; i < targetLine; i++) offset += lines[i]!.length + 1
    buffer.point = Math.max(0, Math.min(buffer.text.length, offset + Math.min(col - 1, lines[targetLine]!.length)))
    buffer.deactivateMark()
    void this.changed(forward ? "scroll-up" : "scroll-down")
  }

  nextWindow(delta = 1): void {
    if (listWindowLeaves(this.windowLayout).length <= 1) return
    this.persistSelectedWindowPoint()
    this.selectedWindowId = nextWindowId(this.windowLayout, this.selectedWindowId, delta)
    this.currentBufferId = findWindowLeaf(this.windowLayout, this.selectedWindowId)!.bufferId
    this.restoreSelectedWindowPoint()
    void this.changed("select-window")
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

  newTab(): void {
    this.tabs.push({ name: String(this.tabs.length + 1), bufferId: this.currentBufferId })
    this.selectedTab = this.tabs.length - 1
    void this.changed("new-tab")
  }

  switchTab(delta: number): void {
    if (!this.tabs.length) return
    this.selectedTab = (this.selectedTab + delta + this.tabs.length) % this.tabs.length
    this.currentBufferId = this.tabs[this.selectedTab]!.bufferId
    this.windowLayout = setWindowLeafBuffer(this.windowLayout, this.selectedWindowId, this.currentBufferId, this.currentBuffer.point)
    void this.changed("switch-tab")
  }

  closeTab(): void {
    if (this.tabs.length <= 1) return
    this.tabs.splice(this.selectedTab, 1)
    this.selectedTab = Math.min(this.selectedTab, this.tabs.length - 1)
    this.currentBufferId = this.tabs[this.selectedTab]!.bufferId
    this.windowLayout = setWindowLeafBuffer(this.windowLayout, this.selectedWindowId, this.currentBufferId, this.currentBuffer.point)
    void this.changed("close-tab")
  }

  cycleTilingLayout(): string {
    const layouts = ["tiling-master-left", "tiling-master-top", "tiling-even-horizontal", "tiling-even-vertical", "tiling-tile-4"]
    this.tilingLayout = layouts[(layouts.indexOf(this.tilingLayout) + 1) % layouts.length]!
    void this.changed("tiling-cycle")
    return this.tilingLayout
  }

  universalArgument(): number {
    const value = this.prefixArg.universalArgument()
    const sign = this.prefixArg.isNegative() ? "-" : ""
    this.message(`C-u ${sign}${value}`)
    return value
  }

  consumePrefixArgument(): number | null {
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
    if (!state?.string) return
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
      ? findForward(buffer.text, string, from)
      : findBackward(buffer.text, string, from)
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

  minibufferInsert(s: string): void {
    if (!this.minibuffer) return
    this.activeBuffer.insert(s)
    void this.changed("minibuffer-input")
  }

  minibufferBackspace(): void {
    if (!this.minibuffer) return
    this.activeBuffer.deleteBackward()
    void this.changed("minibuffer-backspace")
  }

  minibufferSubmit(): void {
    if (!this.minibuffer) return
    const request = this.minibuffer
    const value = this.activeBuffer.text
    if (request.historyName && value) {
      const history = this.minibufferHistory.get(request.historyName) ?? []
      history.push(value)
      this.minibufferHistory.set(request.historyName, history)
    }
    request.resolve(value)
    void this.changed("minibuffer-submit")
  }

  minibufferCancel(): void {
    if (!this.minibuffer) return
    const request = this.minibuffer
    request.resolve(null)
    void this.changed("minibuffer-cancel")
  }

  async minibufferComplete(): Promise<void> {
    const request = this.minibuffer
    if (!request) return
    const buffer = this.activeBuffer
    const collection = request.completion === "file"
      ? await fileCompletionCandidates(buffer.text, request.fileCompletionDirectory ?? process.cwd())
      : request.collection ?? []
    if (!collection.length) return

    const matches = collection.filter(item => item.startsWith(buffer.text))
    if (matches.length === 1) {
      this.setMinibufferText(matches[0]!, matches[0]!.length)
      return
    }
    if (matches.length > 1) {
      const common = commonPrefix(matches)
      if (common.length > buffer.text.length) {
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
      msg.text += `${new Date().toISOString()}  ${text}\n`
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
    void this.changed("quit")
  }

  private activeKeymaps(): Array<{ name: string; keymap: Keymap }> {
    const maps: Array<{ name: string; keymap: Keymap }> = []
    if (this.overridingTerminalLocalMap) maps.push({ name: "overriding-terminal-local-map", keymap: this.overridingTerminalLocalMap })
    if (this.overridingMap) maps.push({ name: "overriding-map", keymap: this.overridingMap })
    if (this.minibuffer) {
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
