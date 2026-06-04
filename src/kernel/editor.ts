import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { BufferModel } from "./buffer"
import { CommandRegistry, type CommandFn } from "./command"
import { Emitter } from "./events"
import { isPrintable, Keymap, KeymapStack, keyToken, type KeyEventLike } from "./keymap"
import { enterMode, getMode, modeFeature, modeLineage, type TextSpan } from "../modes/mode"
import { makeDiredBuffer } from "../modes/dired"
import { defaultTheme, type Theme } from "../display/theme"
import { findBackward, findForward, isearchPrompt, type IsearchState } from "./isearch"

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
  resolve: (value: string | null) => void
}

export type CompletingReadOptions = {
  collection: string[]
  history?: string
  initialValue?: string
}

export type KeyDispatchResult =
  | { status: "command"; command: string }
  | { status: "pending" }
  | { status: "inserted" }
  | { status: "unmatched" }

export class Editor {
  readonly buffers = new Map<string, BufferModel>()
  readonly commands = new CommandRegistry()
  readonly keymap = new Keymap("global-map")
  readonly minibufferKeymap = new Keymap("minibuffer-local-map")
  readonly events = new Emitter<EditorEvents>()
  readonly keymaps = new KeymapStack(() => this.activeKeymaps())
  readonly minibufferHistory = new Map<string, string[]>()
  readonly registers = new Map<string, number>()
  readonly tabs: Array<{ name: string; bufferId: string }> = []
  readonly windows: string[] = []
  theme: Theme = defaultTheme
  selectedWindow = 0
  selectedTab = 0
  tilingLayout = "tiling-master-left"
  currentBufferId: string
  minibuffer: MinibufferRequest | null = null
  isearch: IsearchState | null = null
  running = true
  overridingTerminalLocalMap: Keymap | null = null
  overridingMap: Keymap | null = null
  prefixArgument: number | null = null
  private minibufferDepth = 0

  constructor() {
    const scratch = new BufferModel({ name: "*scratch*", text: "// Try: editor.message('hello from eval')\n", kind: "scratch", mode: "javascript" })
    const messages = new BufferModel({ name: "*messages*", text: "", kind: "messages" })
    this.addBuffer(scratch)
    this.addBuffer(messages)
    this.currentBufferId = scratch.id
    this.windows.push(scratch.id)
    this.tabs.push({ name: "1", bufferId: scratch.id })
  }

  get currentBuffer(): BufferModel {
    return this.buffers.get(this.currentBufferId) ?? [...this.buffers.values()][0]!
  }

  get activeBuffer(): BufferModel {
    if (!this.minibuffer) return this.currentBuffer
    return this.buffers.get(this.minibuffer.bufferId) ?? this.currentBuffer
  }

  addBuffer(buffer: BufferModel): BufferModel {
    this.buffers.set(buffer.id, buffer)
    return buffer
  }

  switchToBuffer(idOrName: string): BufferModel {
    const found = this.buffers.get(idOrName) ?? [...this.buffers.values()].find(b => b.name === idOrName)
    if (!found) throw new Error(`No such buffer: ${idOrName}`)
    this.currentBufferId = found.id
    this.windows[this.selectedWindow] = found.id
    if (this.tabs[this.selectedTab]) this.tabs[this.selectedTab]!.bufferId = found.id
    void this.changed("switch-buffer")
    return found
  }

  nextBuffer(): BufferModel {
    const values = [...this.buffers.values()].filter(b => b.kind !== "minibuffer")
    const i = values.findIndex(b => b.id === this.currentBufferId)
    const next = values[(i + 1) % values.length]!
    this.currentBufferId = next.id
    this.windows[this.selectedWindow] = next.id
    if (this.tabs[this.selectedTab]) this.tabs[this.selectedTab]!.bufferId = next.id
    void this.changed("next-buffer")
    return next
  }

  previousBuffer(): BufferModel {
    const values = [...this.buffers.values()].filter(b => b.kind !== "minibuffer")
    const i = values.findIndex(b => b.id === this.currentBufferId)
    const previous = values[(i - 1 + values.length) % values.length]!
    this.currentBufferId = previous.id
    this.windows[this.selectedWindow] = previous.id
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
    this.currentBufferId = buffer.id
    this.windows[this.selectedWindow] = buffer.id
    if (this.tabs[this.selectedTab]) this.tabs[this.selectedTab]!.bufferId = buffer.id
    this.enterMode(buffer, buffer.mode)
    await this.changed("open-file")
    return buffer
  }

  async openDirectory(path: string): Promise<BufferModel> {
    const full = resolve(path)
    const existing = [...this.buffers.values()].find(b => b.path === full && b.kind === "directory")
    if (existing) return this.switchToBuffer(existing.id)
    const buffer = await makeDiredBuffer(full)
    this.addBuffer(buffer)
    this.currentBufferId = buffer.id
    this.windows[this.selectedWindow] = buffer.id
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
      this.currentBufferId = existing.id
      this.windows[this.selectedWindow] = existing.id
      if (this.tabs[this.selectedTab]) this.tabs[this.selectedTab]!.bufferId = existing.id
      void this.changed("scratch-update")
      return existing
    }
    const buffer = new BufferModel({ name, text, kind: "scratch", mode })
    this.addBuffer(buffer)
    this.enterMode(buffer, mode)
    this.currentBufferId = buffer.id
    this.windows[this.selectedWindow] = buffer.id
    if (this.tabs[this.selectedTab]) this.tabs[this.selectedTab]!.bufferId = buffer.id
    void this.changed("scratch")
    return buffer
  }

  enterMode(buffer: BufferModel, modeName: string): void {
    enterMode(buffer, getMode(modeName) ? modeName : "text")
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
      const mode = getMode(mapName.replace(/-map$/, ""))
      if (!mode?.keymap) throw new Error(`Unknown keymap: ${mapName}`)
      mode.keymap.bind(sequence, commandName)
    }
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
    if (this.isearch) {
      const isearchResult = await this.handleIsearchKey(key)
      if (isearchResult) return isearchResult
    }

    const fed = this.keymaps.feed(key)
    if (fed.status === "matched") {
      await this.run(fed.command)
      return { status: "command", command: fed.command }
    }

    if (fed.status === "pending") {
      await this.changed("key-prefix")
      return { status: "pending" }
    }

    const buffer = this.activeBuffer
    switch (key.name) {
      case "left":
        buffer.move(-1)
        await this.changed("key:left")
        return { status: "inserted" }
      case "right":
        buffer.move(1)
        await this.changed("key:right")
        return { status: "inserted" }
      case "up":
        if (this.minibuffer) await this.minibufferPreviousHistory()
        else buffer.moveLine(-1)
        await this.changed("key:up")
        return { status: "inserted" }
      case "down":
        if (this.minibuffer) await this.minibufferNextHistory()
        else buffer.moveLine(1)
        await this.changed("key:down")
        return { status: "inserted" }
      case "backspace":
        buffer.deleteBackward()
        await this.changed("key:backspace")
        return { status: "inserted" }
      case "delete":
        buffer.deleteForward()
        await this.changed("key:delete")
        return { status: "inserted" }
      case "return":
        if (this.minibuffer) this.minibufferSubmit()
        else buffer.insert("\n")
        await this.changed("key:return")
        return { status: "inserted" }
      case "escape":
        await this.run("keyboard-quit")
        return { status: "command", command: "keyboard-quit" }
      default:
        if (isPrintable(key)) {
          buffer.insert((key.sequence ?? "").repeat(this.consumePrefixArgument() ?? 1))
          await this.changed(`key:${key.name}`)
          return { status: "inserted" }
        }
    }

    this.message(`Unbound key: ${keyToken(key)}`)
    return { status: "unmatched" }
  }

  async prompt(prompt: string, initialValue = "", historyName?: string, collection?: string[]): Promise<string | null> {
    const previous = this.minibuffer
    this.minibufferDepth++
    return await new Promise(resolve => {
      const buffer = new BufferModel({ name: ` *Minibuffer-${this.minibufferDepth}*`, text: initialValue, kind: "minibuffer", mode: "minibuffer" })
      buffer.point = buffer.text.length
      this.addBuffer(buffer)
      this.minibuffer = { prompt, bufferId: buffer.id, historyName, historyIndex: null, collection, resolve: value => {
        this.buffers.delete(buffer.id)
        this.minibuffer = previous
        this.minibufferDepth--
        resolve(value)
      } }
      void this.events.emit("minibuffer", { prompt })
      void this.changed("minibuffer-open")
    })
  }

  completingRead(prompt: string, options: CompletingReadOptions): Promise<string | null> {
    return this.prompt(prompt, options.initialValue ?? "", options.history, options.collection)
  }

  indentLine(buffer = this.activeBuffer): void {
    const indent = modeFeature(buffer.mode, "indentLine")
    if (indent) indent(buffer)
    else buffer.insert("  ")
    void this.changed("indent-line")
  }

  completeAtPoint(buffer = this.activeBuffer): boolean {
    const complete = modeFeature(buffer.mode, "completeAtPoint")
    const candidates = complete?.(buffer) ?? []
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
    return modeFeature(buffer.mode, "fontLock")?.(buffer) ?? []
  }

  setTheme(theme: Theme): void {
    this.theme = theme
    void this.changed("theme")
  }

  splitWindow(): void {
    this.windows.splice(this.selectedWindow + 1, 0, this.currentBufferId)
    this.selectedWindow++
    void this.changed("split-window")
  }

  nextWindow(delta = 1): void {
    if (!this.windows.length) return
    this.selectedWindow = (this.selectedWindow + delta + this.windows.length) % this.windows.length
    this.currentBufferId = this.windows[this.selectedWindow]!
    void this.changed("select-window")
  }

  deleteWindow(): void {
    if (this.windows.length <= 1) return
    this.windows.splice(this.selectedWindow, 1)
    this.selectedWindow = Math.min(this.selectedWindow, this.windows.length - 1)
    this.currentBufferId = this.windows[this.selectedWindow]!
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
    this.windows[this.selectedWindow] = this.currentBufferId
    void this.changed("switch-tab")
  }

  closeTab(): void {
    if (this.tabs.length <= 1) return
    this.tabs.splice(this.selectedTab, 1)
    this.selectedTab = Math.min(this.selectedTab, this.tabs.length - 1)
    this.currentBufferId = this.tabs[this.selectedTab]!.bufferId
    this.windows[this.selectedWindow] = this.currentBufferId
    void this.changed("close-tab")
  }

  cycleTilingLayout(): string {
    const layouts = ["tiling-master-left", "tiling-master-top", "tiling-even-horizontal", "tiling-even-vertical", "tiling-tile-4"]
    this.tilingLayout = layouts[(layouts.indexOf(this.tilingLayout) + 1) % layouts.length]!
    void this.changed("tiling-cycle")
    return this.tilingLayout
  }

  universalArgument(): void {
    this.prefixArgument = (this.prefixArgument ?? 1) * 4
    this.message(`C-u ${this.prefixArgument}`)
  }

  consumePrefixArgument(): number | null {
    const value = this.prefixArgument
    this.prefixArgument = null
    return value
  }

  startIsearch(direction: 1 | -1): void {
    const buffer = this.currentBuffer
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

  minibufferComplete(): void {
    const request = this.minibuffer
    if (!request?.collection?.length) return
    const buffer = this.activeBuffer
    const matches = request.collection.filter(item => item.startsWith(buffer.text))
    if (matches.length === 1) {
      buffer.setText(matches[0]!, true)
      buffer.point = buffer.text.length
      return
    }
    if (matches.length > 1) {
      const common = commonPrefix(matches)
      if (common.length > buffer.text.length) {
        buffer.setText(common, true)
        buffer.point = buffer.text.length
      }
      const existing = [...this.buffers.values()].find(b => b.name === "*Completions*")
      if (existing) existing.setText(matches.join("\n"), false)
      else this.addBuffer(new BufferModel({ name: "*Completions*", text: matches.join("\n"), kind: "scratch", mode: "text" }))
    }
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
    if (this.minibuffer) maps.push({ name: "minibuffer-local-map", keymap: this.minibufferKeymap })
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
