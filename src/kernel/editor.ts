import { readFileSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
import { BufferModel, FUNDAMENTAL_MODE, inferMode } from "./buffer"
import { CommandRegistry, type CommandFn } from "./command"
import { Emitter } from "./events"
import { emacsKeyDescription, isPrintable, Keymap, KeymapStack, keyToken, normalizeSequence, type KeyEventLike } from "./keymap"
import { digitFromKey, PrefixArgumentState } from "./prefix-argument"
import type {
  CompletionCandidate,
  FontLockRange,
  GutterDecoration,
  MinorModeSpec as MinorMode,
  TextSpan,
  Theme,
} from "./extension-points"
import { displaySystem, modeSystem, pointKeymaps } from "./extension-points"
import type { HostCapabilities } from "../display/protocol"
import type { TerminalData } from "../display/protocol"
import type { ViewportSize } from "../display/viewport"
import { composeTheme, defface } from "../runtime/faces"
import { fileCompletionCandidates } from "./completion"
import { findMatchBackward, findMatchForward, isearchPrompt, type IsearchMatch, type IsearchState } from "./isearch"
import {
  cloneWindowNode,
  createLeafWindow,
  balanceWindowTree,
  deleteOtherWindowLeaves,
  deleteWindowLeaf,
  findWindowLeaf,
  findWindowShowingBuffer,
  listWindowLeaves,
  nextWindowId,
  pickReusableWindow,
  removeBufferFromWindows,
  nextEligibleWindowId,
  setWindowLeafBuffer,
  setWindowLeafDedicated,
  setWindowLeafPoint,
  setWindowLeafStartLine,
  setWindowSplitRatioForLeaf,
  splitWindowLeaf,
  type ChildFrameRecord,
  type ChildFrameParameters,
  type WindowId,
  type WindowNode,
} from "./window"
import { createFrame, makeTab, tabTimestamp, type FrameRecord, type TabRecord } from "./frame"
import type { RegisterContents } from "./register"
import { modeHookName, runHooks, runHooksMaybeAsync } from "./hooks"
import type { LspManager } from "../lsp/manager"
import { fileExists, homedir, isDirectory, mkdir, readFileText, stat, unlink, writeFileText } from "../platform/runtime"
import { invokeWithAdvice } from "../runtime/advice"
import { defcustom, getCustom } from "../runtime/custom"
import { readInteractiveArgs } from "../runtime/interactive"
import { canonicalMapName, registerKeyBinding } from "../runtime/key-registry"
import type { SourceLocation } from "../runtime/source"

export type EditorEvents = {
  changed: { reason: string }
  message: { text: string }
  minibuffer: { prompt: string }
  terminalData: TerminalData
}

type MinibufferRequest = {
  prompt: string
  bufferId: string
  historyName?: string
  historyIndex: number | null
  mask?: boolean
  collection?: string[]
  /** Async candidate source re-queried on every input change (consult-style). */
  dynamicCollection?: DynamicCollection
  completion?: "file"
  fileCompletionDirectory?: string
  resolve: (value: string | null) => void
}

type KeySequenceRequest = {
  prompt: string
  keys: string[]
  resolve: (value: string | null) => void
}

type BufferSelectionOptions = {
  recordRecency?: boolean
  recordWindowHistory?: boolean
}

type WindowBufferHistory = {
  previous: string[]
  next: string[]
}

export const LARGE_FILE_WARNING_THRESHOLD = 10 * 1024 * 1024
export const LARGE_FILE_LITERAL_LOCAL = "buffer-file-literally"
const LARGE_FILE_LOADING_LOCAL = "file-loading"
const LARGE_FILE_SIZE_LOCAL = "large-file-size"

export type CompletingReadOptions = {
  collection?: string[]
  dynamicCollection?: DynamicCollection
  completion?: "file"
  history?: string
  initialValue?: string
  defaultDirectory?: string
}

/**
 * Candidate source consulted on every input change, for collections too large or too remote to
 * enumerate up front (code search, a language server, an HTTP index).
 *
 * The returned candidates are taken as-is: the source already did the matching and the ranking,
 * so the frontend must not re-filter or re-sort them. `signal` aborts as soon as the input moves
 * on, so an implementation is expected to kill its process/request rather than finish it.
 */
export type DynamicCollection = (input: string, signal: AbortSignal) => Promise<string[]>

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
  /** The selection sits on the prompt line rather than on a candidate, so the
   *  minibuffer input itself carries the current-candidate highlight. */
  promptSelected?: boolean
}

/** Emacs `:description`: either a literal string or a thunk evaluated on every redisplay. */
export type TransientText = string | (() => string)

export type TransientInfix = {
  key: string
  label: TransientText
  description?: string
  argument: string
  /** `variable` mirrors Emacs `transient-lisp-variable`, rendered as `" %k %d %v"`. */
  kind?: "toggle" | "value" | "variable"
  defaultValue?: boolean | string
  prompt?: string
  choices?: string[]
  style?: "equals"
  level?: number
  if?: () => boolean
  inaptIf?: () => boolean
  /**
   * Emacs `transient-format-value` override: return the complete `%v` text for
   * this infix, or `""` to render nothing. Used by infix classes that show
   * `(value)` when set and nothing at all when unset.
   */
  formatValue?: (value: string | null) => string
}

export type TransientSuffix = {
  key: string
  label: TransientText
  description?: string
  command: string
  args?: string[]
  transient?: true | "stay" | "return"
  level?: number
  if?: () => boolean
  inaptIf?: () => boolean
}

export type TransientGroup = {
  /** An empty title renders no heading line, matching Emacs `[[...][...]]` column rows. */
  title: TransientText
  level?: number
  /** Emacs `:pad-keys`: pad this group's keys to a common width. Inherited by subgroups. */
  padKeys?: boolean
  /** Emacs group-level `:if`/`:if-derived`: hide the whole group when this returns false. */
  if?: () => boolean
  infixes?: TransientInfix[]
  suffixes?: TransientSuffix[]
  subgroups?: TransientGroup[]
}

export type TransientDefinition = {
  name: string
  title: string
  groups: TransientGroup[]
  defaultLevel?: number
  /** Emacs `:incompatible`: each set lists arguments that cannot be active together. */
  incompatible?: string[][]
}

export type TransientState = {
  definition: TransientDefinition
  values: Map<string, boolean | string>
  pending: string[]
  helpPending: string[] | null
  historyIndex: number | null
  windowId: string
}

type TransientValue = boolean | string
type TransientValueSnapshot = Record<string, TransientValue>
export type TransientDisplay = { text: string; spans: TextSpan[] }
type TransientEngineCommand =
  | "transient-set"
  | "transient-save"
  | "transient-reset"
  | "transient-history-prev"
  | "transient-history-next"

export type CompletingReadFunction = (editor: Editor, prompt: string, options: CompletingReadOptions) => Promise<string | null>

/** Pluggable completion delegate (e.g. fido flex matching). Returns candidates ordered best-first. */
export type Completer = (input: string, collection: string[]) => string[]

export type KeyDispatchResult =
  | { status: "command"; command: string }
  | { status: "pending" }
  | { status: "inserted" }
  | { status: "unmatched" }

function isRedispatchKeyResult(value: unknown): value is { redispatchKey: KeyEventLike } {
  return typeof value === "object" && value !== null && "redispatchKey" in value
}

export class Editor {
  readonly buffers = new Map<string, BufferModel>()
  private readonly fontLockCache = new WeakMap<BufferModel, { text: string; key: string; spans: TextSpan[] }>()
  private readonly overlaySources: Array<(buffer: BufferModel) => TextSpan[]> = []
  private readonly gutterDecorationSources: Array<(buffer: BufferModel) => GutterDecoration[]> = []
  readonly commands = new CommandRegistry()
  readonly keymap = new Keymap("global-map")
  readonly minibufferKeymap = new Keymap("minibuffer-local-map")
  readonly events = new Emitter<EditorEvents>()
  readonly keymaps = new KeymapStack(() => this.activeKeymaps())
  readonly minibufferHistory = new Map<string, string[]>()
  readonly registers = new Map<string, RegisterContents>()
  /** Editor-scoped scratch storage for plugins (parallels BufferModel.locals). */
  readonly locals = new Map<string, unknown>()
  readonly childFrames = new Map<string, ChildFrameRecord>()
  /** Open frames, in creation order. Never empty; `selectedFrameId` names the focused one. */
  readonly frames: FrameRecord[] = []
  selectedFrameId!: string
  /** Buffer offset where the last mouse press landed; drag events extend the region from it. */
  private dragAnchor: number | null = null
  /** Read-only view of the selected frame's window tree. Mutate via kernel primitives (setSelectedWindowPoint etc). */
  get windowLayout(): WindowNode { return this.selectedFrame.layout }
  private set windowLayout(layout: WindowNode) { this.selectedFrame.layout = layout }
  get selectedWindowId(): WindowId { return this.selectedFrame.selectedWindowId }
  set selectedWindowId(id: WindowId) { this.selectedFrame.selectedWindowId = id }

  /** Tab-bar tabs of the selected frame (Emacs keeps `tabs` per frame). */
  get tabs(): TabRecord[] { return this.selectedFrame.tabs }
  get selectedTab(): number { return this.selectedFrame.selectedTab }
  set selectedTab(index: number) { this.selectedFrame.selectedTab = index }
  /** Tabs closed by `tab-bar-close-tab`, most recent first (`tab-bar-closed-tabs`). */
  readonly closedTabs: Array<{ frameId: string; index: number; tab: TabRecord }> = []

  get selectedFrame(): FrameRecord {
    return this.frames.find(frame => frame.id === this.selectedFrameId) ?? this.frames[0]!
  }
  // Real theme arrives via `setTheme` from installDefaultConfig / load-theme;
  // a bare kernel renders unstyled rather than reaching into themes/.
  theme: Theme = { name: "none", faces: {} }
  private baseTheme: Theme = this.theme
  minibuffer: MinibufferRequest | null = null
  transient: TransientState | null = null
  private readonly transientStack: TransientState[] = []
  private suspendedTransient: { active: TransientState; stack: TransientState[] } | null = null
  private readonly transientSessionValues = new Map<string, TransientValueSnapshot>()
  private transientSavedValues = new Map<string, TransientValueSnapshot>()
  private transientSavedValuesFile: string | null = null
  private transientSavedValuesFileExists = false
  private readonly transientHistory = new Map<string, TransientValueSnapshot[]>()
  isearch: IsearchState | null = null
  /** Per-key dispatch while isearch is active; the UI loop is owned by lisp/isearch-ui (DESIGN.md). */
  isearchKeyHandler: ((key: KeyEventLike) => Promise<KeyDispatchResult | null>) | null = null
  running = true
  overridingTerminalLocalMap: Keymap | null = null
  overridingMap: Keymap | null = null
  readonly prefixArg = new PrefixArgumentState()
  readonly globalMinorModes = new Set<string>()
  lastKeyEvent: KeyEventLike | null = null
  quotedInsertNext = false
  quotedInsertCount = 1
  quotedInsertCode: { digits: string; radix: number; count: number } | null = null
  quotedInsertSwallowTerminator = false
  macroRecording: string[] | null = null
  lastKbdMacro: string[] = []
  private lastEchoMessage = ""
  private keySequenceRequest: KeySequenceRequest | null = null
  lsp: LspManager | null = null
  /** Stack of completing-read overrides; top wins. push/pop instead of save/restore so
   *  enable A → enable B → disable A → disable B doesn't resurrect A's function. */
  private readonly completingReadFns: CompletingReadFunction[] = []
  private readonly completionFrontends: MinibufferCompletionFrontend[] = []
  minibufferCompletionDisplay: MinibufferCompletionDisplay | null = null
  /** In-flight `dynamicCollection` query; aborted whenever the input moves on. */
  private dynamicCollectionAbort: AbortController | null = null
  completer: Completer | null = null
  /** Gutter predicate consulted by build-display-model; modes (linum) install the policy. */
  showLineNumbers: (buffer?: BufferModel) => boolean = () => false
  /** Last host viewport; updated each redisplay for page scroll sizing.
   *  Left unset until the first present(); scroll.ts falls back to terminal rows. */
  lastViewport?: ViewportSize
  lastHostCapabilities?: HostCapabilities
  readonly searchRing: string[] = []
  private minibufferDepth = 0
  private readonly displayNames = new Map<string, string>()
  /** Buffer ids most-recently-selected first; killBuffer's fallback source. */
  private readonly bufferRecency: string[] = []
  private readonly windowBufferHistory = new Map<string, WindowBufferHistory>()
  private _currentBufferId!: string
  private recordBufferRecency = true
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null

  get currentBufferId(): string { return this._currentBufferId }
  set currentBufferId(id: string) {
    this._currentBufferId = id
    if (this.buffers.get(id)?.kind === "minibuffer") return
    // Emacs's current tab holds no buffer of its own: it *is* the live window
    // configuration, so its name and buffer follow the selected window. Track
    // that here rather than at each call site, or a tab left via any path the
    // commands don't own keeps a stale name. `frames` is empty during the
    // constructor's first assignment.
    const frame = this.frames.length ? this.selectedFrame : null
    const tab = frame?.tabs[frame.selectedTab]
    if (tab) {
      tab.bufferId = id
      if (!tab.explicitName) tab.name = this.bufferDisplayName(id)
    }
    if (!this.recordBufferRecency) return
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
    const initialFrame = createFrame(scratch.id, "F1", scratch.point)
    initialFrame.tabs[0]!.name = scratch.name
    this.frames.push(initialFrame)
    this.selectedFrameId = initialFrame.id
    defcustom("transient-values-file", "string", join(homedir(), ".jemacs", "transient.json"), "File where transient-saved values are persisted.", "transient")
    defcustom("transient-default-level", "integer", 4, "Default visibility level for transient groups and suffixes.", "transient")
    this.command("transient-resume", ({ editor }) => editor.resumeTransient(), "Resume the last suspended transient popup.")
    this.command("transient-quit-one", ({ editor }) => editor.transientQuitOne(), "Quit the active transient popup.")
    this.command("transient-quit-all", ({ editor }) => editor.transientQuitAll(), "Quit the active transient popup and its stack.")
    this.command("transient-set", ({ editor }) => editor.transientSet(), "Set the active transient values for this session.")
    this.command("transient-save", async ({ editor }) => editor.transientSave(), "Save the active transient values across sessions.")
    this.command("transient-reset", async ({ editor }) => editor.transientReset(), "Reset the active transient values to their defaults.")
    this.command("transient-history-prev", ({ editor }) => editor.transientHistoryCycle("prev"), "Load older transient argument history.")
    this.command("transient-history-next", ({ editor }) => editor.transientHistoryCycle("next"), "Load newer transient argument history.")
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

  /** Kernel primitive: apply a pure tree-mutation to the window layout with point persist/restore
   *  bracketed around it. Re-selects a surviving leaf if `fn` deleted the selected one. lisp/ uses
   *  this to build split/delete/balance commands without the kernel owning each wrapper. */
  mutateWindowLayout(fn: (layout: WindowNode) => WindowNode, reason?: string): void {
    this.persistSelectedWindowPoint()
    this.windowLayout = fn(this.windowLayout)
    if (!findWindowLeaf(this.windowLayout, this.selectedWindowId)) {
      this.selectedWindowId = listWindowLeaves(this.windowLayout)[0]!.id
    }
    this.pruneWindowBufferHistories()
    this.currentBufferId = findWindowLeaf(this.windowLayout, this.selectedWindowId)!.bufferId
    this.restoreSelectedWindowPoint()
    if (reason) void this.changed(reason)
  }

  private persistSelectedWindowPoint(): void {
    const leaf = this.selectedWindowLeaf()
    if (!leaf) return
    this.windowLayout = setWindowLeafPoint(this.windowLayout, leaf.id, this.currentBuffer.point)
  }

  /** Keep the cursor on screen without recentering the whole window on focus changes. */
  syncSelectedWindowViewport(lineBudget: number, lineWeights?: readonly number[]): void {
    const leaf = this.selectedWindowLeaf()
    if (!leaf) return
    const buffer = this.buffers.get(leaf.bufferId)
    if (!buffer) return
    const cursorLine = this.lineAtPoint(buffer.point)
    const start = displaySystem.syncViewportStartLine(leaf.startLine, cursorLine, lineBudget, lineWeights)
    if (start !== leaf.startLine) {
      this.windowLayout = setWindowLeafStartLine(this.windowLayout, leaf.id, start)
    }
  }

  private lineAtPoint(point: number): number {
    return this.currentBuffer.lineAt(Math.max(0, Math.min(point, this.currentBuffer.text.length)))
  }

  selectWindow(windowId: string): void {
    if (!findWindowLeaf(this.windowLayout, windowId)) return
    this.persistSelectedWindowPoint()
    this.selectedWindowId = windowId
    this.currentBufferId = findWindowLeaf(this.windowLayout, windowId)!.bufferId
    this.restoreSelectedWindowPoint()
  }

  /** Select a window and move point. The host bridge maps cell→point before calling
   *  (display/ owns that math), so the kernel only sees the resolved buffer offset. */
  clickWindow(windowId: string, point: number, drag = false): void {
    const leaf = findWindowLeaf(this.windowLayout, windowId)
    if (!leaf) return
    this.selectWindow(windowId)
    const buffer = this.buffers.get(leaf.bufferId)
    if (!buffer) return
    if (drag) {
      // The press recorded the anchor; moving point with the mark active there
      // paints the region as the cursor sweeps.
      if (this.dragAnchor == null) return
      buffer.mark = this.dragAnchor
      buffer.markActive = true
      buffer.point = point
      this.windowLayout = setWindowLeafPoint(this.windowLayout, windowId, point)
      void this.changed("mouse-drag")
      return
    }
    buffer.point = point
    this.dragAnchor = point
    buffer.deactivateMark()
    this.windowLayout = setWindowLeafPoint(this.windowLayout, windowId, point)
    const click = modeSystem.modeFeature(buffer.mode, "mouseClick")
    if (click?.(buffer, point)) {
      void this.changed("mouse-click")
      return
    }
    void this.changed("mouse-click")
  }

  ensureOtherWindowSelected(): void {
    if (listWindowLeaves(this.windowLayout).length === 1) {
      this.selectWindow(this.splitSelectedWindow("vertical"))
      return
    }
    const otherId = nextEligibleWindowId(
      this.windowLayout,
      this.selectedWindowId,
      1,
      leaf => leaf.id !== this.selectedWindowId && !leaf.dedicated,
    )
    if (otherId) this.selectWindow(otherId)
    else this.selectWindow(this.splitSelectedWindow("vertical"))
  }

  /**
   * Create a new frame showing `bufferId` (default: the current buffer) and
   * select it. Buffers are editor-global, so the new frame shares them with
   * every existing frame — editing in one is immediately visible in the others.
   */
  makeFrame(bufferId = this.currentBufferId, name?: string): FrameRecord {
    this.persistSelectedWindowPoint()
    // Freeze the departing frame's tab, so its name and layout stay correct
    // while another frame is focused.
    this.captureSelectedTab()
    const buffer = this.buffers.get(bufferId) ?? this.currentBuffer
    const frame = createFrame(buffer.id, name ?? this.nextFrameName())
    frame.tabs[0]!.name = this.bufferDisplayName(buffer)
    this.frames.push(frame)
    this.selectedFrameId = frame.id
    this.currentBufferId = buffer.id
    this.restoreSelectedWindowPoint()
    void this.changed("make-frame")
    return frame
  }

  selectFrame(frameId: string): boolean {
    if (frameId === this.selectedFrameId) return true
    if (!this.frames.some(frame => frame.id === frameId)) return false
    this.persistSelectedWindowPoint()
    this.captureSelectedTab()
    this.selectedFrameId = frameId
    // Point lives on the shared buffer, so adopt the point this frame last
    // parked in its selected window rather than the other frame's cursor.
    this.currentBufferId = this.selectedWindowLeaf()?.bufferId ?? this.currentBufferId
    this.restoreSelectedWindowPoint()
    void this.changed("select-frame")
    return true
  }

  /** Close a frame. The last remaining frame is never deleted (as in Emacs). */
  deleteFrame(frameId = this.selectedFrameId): boolean {
    if (this.frames.length <= 1) return false
    const index = this.frames.findIndex(frame => frame.id === frameId)
    if (index === -1) return false
    // Tabs of a deleted frame can never be reopened, so drop their undo entries.
    const doomed = this.frames[index]!
    for (let i = this.closedTabs.length - 1; i >= 0; i--) {
      if (this.closedTabs[i]!.frameId === doomed.id) this.closedTabs.splice(i, 1)
    }
    this.frames.splice(index, 1)
    if (frameId === this.selectedFrameId) {
      const next = this.frames[Math.min(index, this.frames.length - 1)]!
      this.selectedFrameId = next.id
      this.currentBufferId = this.selectedWindowLeaf()?.bufferId ?? this.currentBufferId
      this.restoreSelectedWindowPoint()
    }
    void this.changed("delete-frame")
    return true
  }

  otherFrameId(delta = 1): string {
    const index = this.frames.findIndex(frame => frame.id === this.selectedFrameId)
    const count = this.frames.length
    return this.frames[(((index + delta) % count) + count) % count]!.id
  }

  private nextFrameName(): string {
    const used = new Set(this.frames.map(frame => frame.name))
    for (let n = 1; ; n++) {
      const name = `F${n}`
      if (!used.has(name)) return name
    }
  }

  // ---------------------------------------------------------------------------
  // Tab-bar tabs. A tab is a named window configuration, as in tab-bar.el: the
  // selected tab keeps no stored config because its layout is the frame's live
  // one, and `captureSelectedTab` freezes it the moment the tab is left.
  // Commands live in lisp/tab-bar.ts; the kernel owns only the state.
  // ---------------------------------------------------------------------------

  /**
   * Emacs `tab-bar-tab-name-current`: the name shown on a tab.
   *
   * Only the current tab tracks its buffer live; `tab-bar-tabs` refreshes that
   * one name per redisplay and leaves every other tab with the name it had when
   * it was last left. An explicitly renamed tab keeps its name in both cases.
   */
  tabName(tab: TabRecord): string {
    if (tab.explicitName) return tab.name
    const live = tab === this.selectedFrame.tabs[this.selectedFrame.selectedTab]
    return live ? this.bufferDisplayName(this.currentBufferId) : tab.name
  }

  /** Emacs `tab-bar--tab`: write the live window configuration onto the selected tab. */
  captureSelectedTab(): void {
    const frame = this.selectedFrame
    const tab = frame.tabs[frame.selectedTab]
    if (!tab) return
    tab.config = this.currentWindowConfiguration()
    tab.bufferId = this.currentBufferId
    if (!tab.explicitName) tab.name = this.bufferDisplayName(this.currentBufferId)
  }

  /** A tab recording the current window configuration. */
  makeTabFromCurrent(name = "", explicitName = false): TabRecord {
    const tab = makeTab(this.currentBufferId, name, explicitName)
    if (!explicitName) tab.name = this.bufferDisplayName(this.currentBufferId)
    tab.config = this.currentWindowConfiguration()
    return tab
  }

  /**
   * Emacs `tab-bar-select-tab`: select tab `index` of the selected frame and
   * restore its window configuration. Selecting the current tab only refreshes
   * its recency stamp, exactly as Emacs does.
   */
  selectTab(index: number): boolean {
    const frame = this.selectedFrame
    const tab = frame.tabs[index]
    if (!tab) return false
    if (index === frame.selectedTab) {
      tab.time = tabTimestamp()
      return true
    }
    this.captureSelectedTab()
    frame.selectedTab = index
    tab.time = tabTimestamp()
    if (tab.config) this.restoreWindowConfiguration(tab.config)
    tab.bufferId = this.currentBufferId
    void this.changed("select-tab")
    return true
  }

  /** Point every saved tab configuration away from a buffer that is being killed. */
  private replaceBufferInTabs(bufferId: string, fallbackId: string): void {
    const patch = (tab: TabRecord) => {
      if (tab.bufferId === bufferId) {
        tab.bufferId = fallbackId
        if (!tab.explicitName) tab.name = this.bufferDisplayName(fallbackId)
      }
      if (!tab.config) return
      tab.config = {
        ...tab.config,
        layout: removeBufferFromWindows(tab.config.layout, bufferId, fallbackId),
        currentBufferId: tab.config.currentBufferId === bufferId ? fallbackId : tab.config.currentBufferId,
      }
    }
    for (const frame of this.frames) for (const tab of frame.tabs) patch(tab)
    for (const closed of this.closedTabs) patch(closed.tab)
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
    this.pruneWindowBufferHistories()
    this.restoreSelectedWindowPoint()
  }

  setSelectedWindowDedicated(dedicated: boolean): void {
    this.windowLayout = setWindowLeafDedicated(this.windowLayout, this.selectedWindowId, dedicated)
    void this.changed("set-window-dedicated")
  }

  private resolveBuffer(idOrName: string): BufferModel | undefined {
    return this.buffers.get(idOrName)
      ?? [...this.buffers.values()].find(b => b.name === idOrName || this.displayNames.get(b.id) === idOrName)
  }

  displayBufferInOtherWindow(idOrName: string, options: { select?: boolean } = {}): BufferModel {
    const select = options.select ?? true
    const found = this.resolveBuffer(idOrName)
    if (!found) throw new Error(`No such buffer: ${idOrName}`)
    const existing = findWindowShowingBuffer(this.windowLayout, found.id, this.selectedWindowId)
    if (existing) {
      if (select) this.selectWindow(existing.id)
      return found
    }
    let targetId: string | null = null
    const reusable = pickReusableWindow(this.windowLayout, this.selectedWindowId)
    if (reusable) targetId = reusable.id
    else {
      targetId = nextEligibleWindowId(this.windowLayout, this.selectedWindowId, 1, leaf => leaf.id !== this.selectedWindowId && !leaf.dedicated)
        ?? this.splitSelectedWindow("vertical")
    }
    if (select) {
      this.selectWindow(targetId)
      this.setSelectedWindowBuffer(found.id)
      if (found.name.startsWith("*") && found.name.endsWith("*")) {
        this.setSelectedWindowDedicated(true)
      }
    } else {
      this.persistSelectedWindowPoint()
      this.windowLayout = setWindowLeafBuffer(this.windowLayout, targetId, found.id, found.point)
      if (found.name.startsWith("*") && found.name.endsWith("*")) {
        this.windowLayout = setWindowLeafDedicated(this.windowLayout, targetId, true)
      }
      void this.changed("display-buffer")
    }
    return found
  }

  displayBufferInChildFrame(idOrName: string, options: { childFrameParameters?: ChildFrameParameters } = {}): ChildFrameRecord {
    const found = this.resolveBuffer(idOrName)
    if (!found) throw new Error(`No such buffer: ${idOrName}`)
    const params = options.childFrameParameters ?? {}
    const parentFrameId = typeof params["parent-frame"] === "string" ? params["parent-frame"] : this.selectedWindowId
    const existing = [...this.childFrames.values()].find(frame => frame.parentFrameId === parentFrameId)
    if (existing) {
      existing.window = { ...existing.window, bufferId: found.id, point: found.point }
      existing.parameters = { "parent-frame": parentFrameId, ...params }
      existing.visible = true
      void this.changed("display-buffer-in-child-frame")
      return existing
    }
    const window = createLeafWindow(found.id, found.point)
    window.dedicated = true
    const record: ChildFrameRecord = {
      id: crypto.randomUUID(),
      parentFrameId,
      window,
      parameters: { "parent-frame": parentFrameId, ...params },
      visible: true,
    }
    this.childFrames.set(record.id, record)
    void this.changed("display-buffer-in-child-frame")
    return record
  }

  private restoreSelectedWindowPoint(): void {
    const leaf = this.selectedWindowLeaf()
    if (!leaf) return
    const buffer = this.buffers.get(leaf.bufferId)
    if (!buffer) return
    buffer.point = Math.min(leaf.point, buffer.text.length)
  }

  private setSelectedWindowBuffer(bufferId: string, options: BufferSelectionOptions = {}): void {
    const oldBufferId = this.selectedWindowLeaf()?.bufferId ?? this.currentBufferId
    this.persistSelectedWindowPoint()
    const record = options.recordRecency ?? true
    if (options.recordWindowHistory ?? record) this.recordWindowBufferSwitch(oldBufferId, bufferId)
    const previous = this.recordBufferRecency
    this.recordBufferRecency = record
    try {
      this.currentBufferId = bufferId
    } finally {
      this.recordBufferRecency = previous
    }
    this.windowLayout = setWindowLeafBuffer(this.windowLayout, this.selectedWindowId, bufferId, this.buffers.get(bufferId)?.point ?? 0)
    this.restoreSelectedWindowPoint()
  }

  private windowHistory(windowId = this.selectedWindowId): WindowBufferHistory {
    let history = this.windowBufferHistory.get(windowId)
    if (!history) {
      history = { previous: [], next: [] }
      this.windowBufferHistory.set(windowId, history)
    }
    return history
  }

  private pushHistoryBuffer(stack: string[], bufferId: string): void {
    const buffer = this.buffers.get(bufferId)
    if (!buffer || buffer.kind === "minibuffer") return
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i] === bufferId) stack.splice(i, 1)
    }
    stack.unshift(bufferId)
    stack.length = Math.min(stack.length, 64)
  }

  private popHistoryBuffer(stack: string[], currentBufferId: string): string | null {
    while (stack.length) {
      const id = stack.shift()!
      const buffer = this.buffers.get(id)
      if (buffer && buffer.kind !== "minibuffer" && id !== currentBufferId) return id
    }
    return null
  }

  private recordWindowBufferSwitch(fromId: string, toId: string): void {
    if (fromId === toId) return
    const history = this.windowHistory()
    this.pushHistoryBuffer(history.previous, fromId)
    history.next = []
    this.removeHistoryBuffer(history.previous, toId)
    this.removeHistoryBuffer(history.next, toId)
  }

  private removeHistoryBuffer(stack: string[], bufferId: string): void {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i] === bufferId) stack.splice(i, 1)
    }
  }

  private removeBufferFromWindowHistories(bufferId: string): void {
    for (const history of this.windowBufferHistory.values()) {
      this.removeHistoryBuffer(history.previous, bufferId)
      this.removeHistoryBuffer(history.next, bufferId)
    }
  }

  private pruneWindowBufferHistories(): void {
    const liveWindows = new Set(listWindowLeaves(this.windowLayout).map(leaf => leaf.id))
    for (const [windowId, history] of this.windowBufferHistory) {
      if (!liveWindows.has(windowId)) {
        this.windowBufferHistory.delete(windowId)
        continue
      }
      history.previous = history.previous.filter(id => this.buffers.get(id)?.kind !== "minibuffer")
      history.next = history.next.filter(id => this.buffers.get(id)?.kind !== "minibuffer")
    }
  }

  get currentBuffer(): BufferModel {
    return this.buffers.get(this.currentBufferId) ?? [...this.buffers.values()][0]!
  }

  get activeBuffer(): BufferModel {
    if (!this.minibuffer) return this.currentBuffer
    return this.buffers.get(this.minibuffer.bufferId) ?? this.currentBuffer
  }

  otherBuffer(buffer: BufferModel = this.currentBuffer): BufferModel | null {
    const id = this.bufferRecency.find(candidateId => candidateId !== buffer.id && this.buffers.get(candidateId)?.kind !== "minibuffer")
    if (id) return this.buffers.get(id) ?? null
    return [...this.buffers.values()].find(candidate => candidate.id !== buffer.id && candidate.kind !== "minibuffer") ?? null
  }

  bufferCycleOrder(): BufferModel[] {
    const seen = new Set<string>()
    const order: BufferModel[] = []
    for (const id of this.bufferRecency) {
      const buffer = this.buffers.get(id)
      if (!buffer || buffer.kind === "minibuffer" || seen.has(id)) continue
      seen.add(id)
      order.push(buffer)
    }
    for (const buffer of this.buffers.values()) {
      if (buffer.kind === "minibuffer" || seen.has(buffer.id)) continue
      seen.add(buffer.id)
      order.push(buffer)
    }
    return order
  }

  cycleBuffer(delta: number): BufferModel {
    if (delta === 0) return this.currentBuffer
    const direction = delta > 0 ? "previous" : "next"
    let result = this.currentBuffer
    for (let step = 0; step < Math.abs(delta); step++) {
      result = this.cycleBufferOne(direction)
    }
    return result
  }

  private cycleBufferOne(direction: "previous" | "next"): BufferModel {
    const currentId = this.currentBufferId
    const history = this.windowHistory()
    const historyStack = direction === "previous" ? history.previous : history.next
    const oppositeStack = direction === "previous" ? history.next : history.previous
    const historyTarget = this.popHistoryBuffer(historyStack, currentId)
    if (historyTarget) {
      this.pushHistoryBuffer(oppositeStack, currentId)
      return this.switchToBuffer(historyTarget, { recordRecency: false, recordWindowHistory: false })
    }

    const values = this.bufferCycleOrder()
    const i = values.findIndex(b => b.id === currentId)
    const start = i === -1 ? 0 : i
    const delta = direction === "previous" ? 1 : -1
    const next = ((start + delta) % values.length + values.length) % values.length
    const target = values[next]!
    if (target.id !== currentId) this.pushHistoryBuffer(oppositeStack, currentId)
    return this.switchToBuffer(target.id, { recordRecency: false, recordWindowHistory: false })
  }

  get minibufferDepthLevel(): number {
    return this.minibufferDepth
  }

  /** Shadow attach hook — set by attachAuthority/attachShadow so buffers created
   *  after attach (find-file, compile) get the same onSplice wiring as the initial set. */
  onAddBuffer?: (buffer: BufferModel) => void

  addBuffer(buffer: BufferModel): BufferModel {
    this.buffers.set(buffer.id, buffer)
    this.uniquifyBufferNames()
    this.onAddBuffer?.(buffer)
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

  switchToBuffer(idOrName: string, options: BufferSelectionOptions = {}): BufferModel {
    const found = this.buffers.get(idOrName)
      ?? [...this.buffers.values()].find(b => b.name === idOrName || this.displayNames.get(b.id) === idOrName)
      ?? this.addBuffer(new BufferModel({ name: idOrName }))
    this.setSelectedWindowBuffer(found.id, options)
    void this.changed("switch-buffer")
    return found
  }

  /** Visit a path: reuse an existing buffer, else create one via `make`. The factory is what
   *  decouples the kernel from modes/ — `modeSystem.makeDirectoryBuffer` supplies the dired one. */
  async visitPath(full: string, make: (full: string) => Promise<BufferModel>, mode?: string, options: { skipFileHooks?: boolean; skipLsp?: boolean } = {}): Promise<BufferModel> {
    const existing = [...this.buffers.values()].find(b => b.path === full)
    if (existing) return this.switchToBuffer(existing.id)
    const buffer = await make(full)
    this.addBuffer(buffer)
    if (buffer.kind === "file" && !options.skipLsp) this.lsp?.attachBuffer(buffer)
    this.setSelectedWindowBuffer(buffer.id)
    this.enterMode(buffer, mode ?? buffer.mode)
    await this.changed("visit-path")
    if (buffer.kind === "file" && !options.skipFileHooks) await this.runHook("find-file-hook", buffer)
    return buffer
  }

  async openFile(path: string, options: { readOnly?: boolean; literally?: boolean } = {}): Promise<BufferModel> {
    const full = resolve(path)
    const st = await stat(full)
    if (st && isDirectory(st)) return this.openDirectory(full)
    if (options.literally || shouldOpenLiterally(st?.size)) {
      return this.openFileLiterally(full, st?.mtime, st?.size ?? 0, options)
    }
    const buffer = await this.visitPath(full, BufferModel.fromFile)
    if (options.readOnly) buffer.readOnly = true
    return buffer
  }

  private async openFileLiterally(full: string, mtime: number | undefined, size: number, options: { readOnly?: boolean } = {}): Promise<BufferModel> {
    const existing = [...this.buffers.values()].find(b => b.path === full)
    if (existing) return this.switchToBuffer(existing.id)
    // `find-file-literally` leaves the buffer in fundamental-mode in Emacs.
    const buffer = new BufferModel({ name: basename(full), path: full, text: "", kind: "file", mode: FUNDAMENTAL_MODE })
    buffer.locals.set(LARGE_FILE_LITERAL_LOCAL, true)
    buffer.locals.set("so-long-mode", true)
    buffer.locals.set(LARGE_FILE_LOADING_LOCAL, true)
    buffer.locals.set(LARGE_FILE_SIZE_LOCAL, size)
    buffer.readOnly = true
    this.addBuffer(buffer)
    this.setSelectedWindowBuffer(buffer.id)
    await this.changed("visit-large-file")
    this.message(`Opening ${buffer.name} literally (${formatBytes(size)})`)

    void readFileText(full).then(text => {
      buffer.setText(text, false, false)
      buffer.markSaved(mtime)
      buffer.readOnly = options.readOnly ?? false
      buffer.locals.delete(LARGE_FILE_LOADING_LOCAL)
      this.message(`Opened ${buffer.name} literally (${formatBytes(size)}); M-x normal-mode to enable major mode`)
      void this.changed("large-file-loaded")
    }).catch(err => {
      buffer.locals.delete(LARGE_FILE_LOADING_LOCAL)
      buffer.setText(`File load failed: ${(err as Error).message}\n`, false, false)
      buffer.readOnly = true
      this.message((err as Error).message)
      void this.changed("large-file-load-failed")
    })

    return buffer
  }

  async normalMode(buffer = this.currentBuffer): Promise<void> {
    if (buffer.locals.get(LARGE_FILE_LOADING_LOCAL)) {
      this.message(`Still loading ${this.bufferDisplayName(buffer)}`)
      return
    }
    const wasLiteral = buffer.locals.get(LARGE_FILE_LITERAL_LOCAL) === true
    const mode = inferMode(buffer.path ?? buffer.name, buffer.text)
    buffer.locals.delete(LARGE_FILE_LITERAL_LOCAL)
    buffer.locals.delete("so-long-mode")
    buffer.locals.delete(LARGE_FILE_SIZE_LOCAL)
    this.enterMode(buffer, mode)
    if (wasLiteral && buffer.kind === "file") {
      this.lsp?.attachBuffer(buffer)
      await this.runHook("find-file-hook", buffer)
    }
    this.message(`Normal mode: ${buffer.mode}`)
    await this.changed("normal-mode")
  }

  async openDirectory(path: string): Promise<BufferModel> {
    const make = modeSystem.makeDirectoryBuffer ?? (async full => {
      const b = new BufferModel({ name: `${basename(full) || full}/`, path: full, kind: "directory" })
      b.readOnly = true
      return b
    })
    return this.visitPath(resolve(path), make, "dired")
  }

  scratch(name: string, text = "", mode = FUNDAMENTAL_MODE, select = true): BufferModel {
    const existing = [...this.buffers.values()].find(b => b.name === name)
    if (existing) {
      existing.setText(text, false)
      existing.kind = name === "*messages*" ? "messages" : "scratch"
      this.enterMode(existing, mode)
      if (select) {
        this.setSelectedWindowBuffer(existing.id)
      }
      void this.changed("scratch-update")
      return existing
    }
    const buffer = new BufferModel({ name, text, kind: "scratch", mode })
    this.addBuffer(buffer)
    this.enterMode(buffer, mode)
    if (select) {
      this.setSelectedWindowBuffer(buffer.id)
    }
    void this.changed("scratch")
    return buffer
  }

  async runHook(name: string, buffer: BufferModel): Promise<void> {
    await runHooks(name, { editor: this, buffer })
  }

  enterMode(buffer: BufferModel, modeName: string): void {
    const resolved = modeSystem.getMode(modeName) ? modeName : FUNDAMENTAL_MODE
    modeSystem.enterMode(buffer, resolved)
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
      const mode = modeSystem.getMode(base)
      const minor = mode ? undefined : modeSystem.getMinorMode(base)
      const target = mode?.keymap ?? minor?.keymap
      if (!target) throw new Error(`Unknown keymap: ${mapName}`)
      target.bind(sequence, commandName)
    }
    registerKeyBinding(map, sequence, commandName, source)
  }

  isMinorModeEnabled(name: string, buffer: BufferModel = this.currentBuffer): boolean {
    const mode = modeSystem.getMinorMode(name)
    if (!mode) return false
    if (this.globalMinorModes.has(name)) return true
    return buffer.minorModes.has(name)
  }

  activeMinorModes(buffer: BufferModel = this.currentBuffer): MinorMode[] {
    return modeSystem.allMinorModes().filter(mode => this.isMinorModeEnabled(mode.name, buffer))
  }

  minorModeLighters(buffer: BufferModel = this.currentBuffer): string {
    return this.activeMinorModes(buffer).map(mode => mode.lighter ?? ` ${mode.name}`).join("")
  }

  enableMinorMode(name: string, options: { buffer?: BufferModel } = {}): void {
    const mode = modeSystem.getMinorMode(name)
    if (!mode) throw new Error(`Unknown minor mode: ${name}`)
    const buffer = options.buffer ?? this.currentBuffer
    if (mode.global) this.globalMinorModes.add(name)
    else buffer.minorModes.add(name)
    mode.onEnable?.(this, buffer)
    void this.changed(`minor-mode-enable:${name}`)
  }

  disableMinorMode(name: string, options: { buffer?: BufferModel } = {}): void {
    const mode = modeSystem.getMinorMode(name)
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
    const ctx = { editor: this, buffer: this.activeBuffer, args: runArgs, prefixArgument, keyEvent }
    this.clearMessage()
    const preCommandHooks = runHooksMaybeAsync("pre-command-hook", { editor: this, buffer: this.activeBuffer })
    if (preCommandHooks) await preCommandHooks
    const result = await invokeWithAdvice(name, spec.fn, ctx)
    const postCommandHooks = runHooksMaybeAsync("post-command-hook", { editor: this, buffer: this.activeBuffer })
    if (postCommandHooks) await postCommandHooks
    await this.changed(`command:${name}`)
    return result
  }

  async handleKey(key: KeyEventLike): Promise<KeyDispatchResult> {
    this.lastKeyEvent = key

    if (this.keySequenceRequest) {
      return this.handleKeySequenceRead(key)
    }

    if (this.isearch && this.isearchKeyHandler) {
      const isearchResult = await this.isearchKeyHandler(key)
      if (isearchResult) return isearchResult
    }

    if (this.transient && !this.minibuffer) {
      const transientResult = await this.handleTransientKey(key)
      if (transientResult) return transientResult
    }

    if (this.quotedInsertNext && this.commands.get("self-insert-command")) {
      const result = await this.run("self-insert-command", key.sequence ? [key.sequence] : [], key)
      if (isRedispatchKeyResult(result)) return this.handleKey(result.redispatchKey)
      if (this.macroRecording && key.sequence) this.macroRecording.push(key.sequence)
      return { status: "command", command: "self-insert-command" }
    }

    if (this.quotedInsertSwallowTerminator) {
      this.quotedInsertSwallowTerminator = false
      if (key.name === "enter" || key.name === "return" || key.name === "linefeed") {
        await this.changed("quoted-insert-terminator")
        return { status: "command", command: "self-insert-command" }
      }
    }

    const digit = digitFromKey(key.name)
    if (digit != null && this.prefixArg.acceptsDigitKey()) {
      await this.run("digit-argument", [String(digit)])
      return { status: "command", command: "digit-argument" }
    }

    let fed = this.keymaps.feed(key)
    if (fed.status === "unmatched" && this.overridingMap) {
      this.overridingMap = null
      fed = this.keymaps.feed(key)
    }
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
    options: { collection?: string[]; dynamicCollection?: DynamicCollection; completion?: "file"; defaultDirectory?: string; mask?: boolean } = {},
  ): Promise<string | null> {
    const previous = this.minibuffer
    return await new Promise((resolve, reject) => {
      const depth = ++this.minibufferDepth
      const buffer = new BufferModel({ name: ` *Minibuffer-${depth}*`, text: initialValue, kind: "minibuffer", mode: "minibuffer" })
      const cleanup = () => {
        this.buffers.delete(buffer.id)
        // A dynamic collection usually owns a subprocess or a request; closing the prompt has
        // to cancel it, otherwise the last query outlives the minibuffer that asked for it.
        this.dynamicCollectionAbort?.abort()
        this.dynamicCollectionAbort = null
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
          mask: options.mask,
          collection: options.collection,
          dynamicCollection: options.dynamicCollection,
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

  async readKeySequence(prompt: string): Promise<string | null> {
    if (this.keySequenceRequest) return null
    return await new Promise(resolve => {
      this.keySequenceRequest = { prompt, keys: [], resolve }
      this.message(prompt)
      void this.changed("read-key-sequence-open")
    })
  }

  private async handleKeySequenceRead(key: KeyEventLike): Promise<KeyDispatchResult> {
    const request = this.keySequenceRequest
    if (!request) return { status: "unmatched" }
    const token = keyToken(key)
    if (token === "C-g") {
      this.keySequenceRequest = null
      request.resolve(null)
      this.message("Quit")
      await this.changed("read-key-sequence-cancel")
      return { status: "command", command: "keyboard-quit" }
    }
    request.keys.push(token)
    const sequence = normalizeSequence(request.keys.join(" "))
    const description = emacsKeyDescription(sequence)
    const result = this.keymaps.lookup(sequence)
    if (result.status === "pending") {
      this.message(`${request.prompt}${description}`)
      await this.changed("read-key-sequence-prefix")
      return { status: "pending" }
    }
    this.keySequenceRequest = null
    request.resolve(description)
    this.clearMessage()
    await this.changed("read-key-sequence-done")
    return { status: "inserted" }
  }

  completingRead(prompt: string, options: CompletingReadOptions): Promise<string | null> {
    if (this.completingReadFunction) return this.completingReadFunction(this, prompt, options)
    return this.prompt(prompt, options.initialValue ?? "", options.history, {
      collection: options.collection,
      dynamicCollection: options.dynamicCollection,
      completion: options.completion,
      defaultDirectory: options.defaultDirectory,
    })
  }

  openTransient(definition: TransientDefinition): void {
    this.loadTransientSavedValues()
    const values = transientDefaultValues(definition)
    const saved = this.transientSavedValues.get(definition.name)
    if (saved) applyTransientValueSnapshot(definition, values, saved)
    const session = this.transientSessionValues.get(definition.name)
    if (session) applyTransientValueSnapshot(definition, values, session)
    if (this.transient) this.transientStack.push(this.transient)
    this.transient = { definition, values, pending: [], helpPending: null, historyIndex: null, windowId: this.selectedWindowId }
    void this.changed("transient-open")
  }

  cancelTransient(message = "Quit"): void {
    if (!this.transient) return
    this.transient = null
    this.transientStack.length = 0
    this.message(message)
    void this.changed("transient-cancel")
  }

  private resumeTransient(): void {
    if (!this.suspendedTransient) return
    this.transientStack.length = 0
    this.transientStack.push(...this.suspendedTransient.stack)
    this.transient = this.suspendedTransient.active
    this.suspendedTransient = null
    void this.changed("transient-resume")
  }

  transientDisplayText(): string | null {
    return this.transientDisplay()?.text ?? null
  }

  transientDisplay(): TransientDisplay | null {
    const state = this.transient
    if (!state) return null
    return this.formatTransient(state)
  }

  private async handleTransientKey(key: KeyEventLike): Promise<KeyDispatchResult | null> {
    const state = this.transient
    if (!state) return null
    if (state.helpPending) return this.handleTransientHelpKey(state, key)
    const token = keyToken(key)
    const sequence = [...state.pending, token].join(" ")
    const infix = transientInfix(state, sequence)
    const suffix = transientSuffix(state, sequence)
    const hasExplicitBinding = Boolean(infix ?? suffix)
    const hasDefinitionPrefix = transientHasPrefix(state, sequence)
    if (!hasExplicitBinding && token === "C-q") {
      this.transientQuitAll()
      await this.changed("transient-cancel")
      return { status: "command", command: "transient-quit-all" }
    }
    if (!hasExplicitBinding && (token === "C-g" || token === "esc") && state.pending.length) {
      state.pending = []
      await this.changed("transient-prefix-cancel")
      return { status: "command", command: "transient-quit-one" }
    }
    if (!state.pending.length && !hasExplicitBinding && (token === "C-g" || token === "esc")) {
      this.transientQuitOne()
      await this.changed("transient-cancel")
      return { status: "command", command: "transient-quit-one" }
    }
    if (!state.pending.length && !hasExplicitBinding && token === "C-z") {
      this.suspendTransient()
      await this.changed("transient-suspend")
      return { status: "command", command: "transient-suspend" }
    }
    const prefixCommand = this.transientPrefixArgumentCommand(token, hasExplicitBinding || hasDefinitionPrefix)
    if (prefixCommand) {
      state.pending = []
      await this.changed(`transient-${prefixCommand}`)
      return { status: "command", command: prefixCommand }
    }
    if (!hasExplicitBinding && !hasDefinitionPrefix && (token === "C-h" || token === "?")) {
      state.pending = []
      state.helpPending = []
      this.message("Describe key: ")
      await this.changed("transient-help")
      return { status: "pending" }
    }
    const engineCommand = transientEngineCommand(sequence)
    if (!hasExplicitBinding && !hasDefinitionPrefix && engineCommand) {
      state.pending = []
      await this.runTransientEngineCommand(engineCommand)
      return { status: "command", command: engineCommand }
    }
    if (infix) {
      const item = infix.item
      state.pending = []
      if (infix.inapt) {
        this.message(`Suffix ${transientText(item.label)} is not applicable`)
        await this.changed("transient-inapt-suffix")
        return { status: "command", command: "transient-inapt-suffix" }
      }
      state.historyIndex = null
      const previous = state.values.get(item.argument)
      if (item.choices?.length) {
        const current = state.values.get(item.argument)
        const index = typeof current === "string" ? item.choices.indexOf(current) : -1
        const next = index === -1 ? item.choices[0] : item.choices[index + 1]
        state.values.set(item.argument, next ?? false)
      } else if (item.kind === "value" || item.kind === "variable") {
        const current = state.values.get(item.argument)
        const initial = typeof current === "string" ? current : ""
        const savedTransient = this.transient
        this.transient = null
        const value = await this.prompt(item.prompt ?? `${transientText(item.label)}: `, initial, `transient-${state.definition.name}-${item.argument}`)
        this.transient = savedTransient
        if (value === "") state.values.set(item.argument, false)
        else if (value != null) state.values.set(item.argument, value)
      } else {
        state.values.set(item.argument, !state.values.get(item.argument))
      }
      if (state.values.get(item.argument) !== previous) {
        transientEnforceIncompatible(state.definition, state.values, item.argument)
      }
      await this.changed("transient-infix")
      return { status: "command", command: "transient-infix" }
    }
    if (suffix) {
      const item = suffix.item
      state.pending = []
      if (suffix.inapt) {
        this.message(`Suffix ${transientText(item.label)} is not applicable`)
        await this.changed("transient-inapt-suffix")
        return { status: "command", command: "transient-inapt-suffix" }
      }
      if (item.command === "transient-quit-one") {
        this.transientQuitOne()
        await this.changed("transient-cancel")
        return { status: "command", command: item.command }
      }
      if (item.command === "transient-quit-all") {
        this.transientQuitAll()
        await this.changed("transient-cancel")
        return { status: "command", command: item.command }
      }
      const args = [...transientArguments(state), ...(item.args ?? [])]
      if (!item.transient) this.transientQuitAll("", false)
      await this.run(item.command, args, key)
      if (args.length) this.pushTransientHistory(state.definition.name, transientValueSnapshot(state))
      if (item.transient === "return" && this.transient === state) {
        this.transientQuitOne("")
        await this.changed("transient-return")
      }
      return { status: "command", command: item.command }
    }
    if (hasDefinitionPrefix || transientEngineHasPrefix(sequence)) {
      state.pending.push(token)
      await this.changed("transient-prefix")
      return { status: "pending" }
    }
    state.pending = []
    this.message(`No transient binding: ${token}`)
    await this.changed("transient-unmatched")
    return { status: "unmatched" }
  }

  private transientPrefixArgumentCommand(token: string, shadowed: boolean): "universal-argument" | "negative-argument" | "digit-argument" | null {
    if (shadowed) return null
    if (token === "C-u") {
      this.prefixArg.universalArgument()
      return "universal-argument"
    }
    if (token === "C--" || token === "M--") {
      this.prefixArg.toggleNegative()
      return "negative-argument"
    }
    const digit = digitFromKey(token)
    if (digit != null && this.prefixArg.acceptsDigitKey()) {
      this.prefixArg.addDigit(digit)
      return "digit-argument"
    }
    return null
  }

  private async handleTransientHelpKey(state: TransientState, key: KeyEventLike): Promise<KeyDispatchResult> {
    const token = keyToken(key)
    if (token === "C-g") {
      state.helpPending = null
      this.message("Quit")
      await this.changed("transient-help-cancel")
      return { status: "command", command: "keyboard-quit" }
    }
    state.helpPending!.push(token)
    const sequence = state.helpPending!.join(" ")
    const infix = transientInfix(state, sequence)
    if (infix) {
      state.helpPending = null
      this.message(infix.item.description ?? transientText(infix.item.label))
      await this.changed("transient-help-describe")
      return { status: "command", command: "transient-help" }
    }
    const suffix = transientSuffix(state, sequence)
    if (suffix) {
      state.helpPending = null
      this.message(suffix.item.description ?? this.commands.get(suffix.item.command)?.description ?? transientText(suffix.item.label))
      await this.changed("transient-help-describe")
      return { status: "command", command: "transient-help" }
    }
    if (transientHasPrefix(state, sequence)) {
      this.message(`Describe key: ${emacsKeyDescription(sequence)}`)
      await this.changed("transient-help-prefix")
      return { status: "pending" }
    }
    state.helpPending = null
    this.message(`No transient binding: ${emacsKeyDescription(sequence)}`)
    await this.changed("transient-help-unmatched")
    return { status: "unmatched" }
  }

  private async runTransientEngineCommand(command: TransientEngineCommand): Promise<void> {
    switch (command) {
      case "transient-set":
        this.transientSet()
        return
      case "transient-save":
        await this.transientSave()
        return
      case "transient-reset":
        await this.transientReset()
        return
      case "transient-history-prev":
        this.transientHistoryCycle("prev")
        return
      case "transient-history-next":
        this.transientHistoryCycle("next")
        return
    }
  }

  private transientSet(): void {
    const state = this.transient
    if (!state) {
      this.message("No active transient")
      return
    }
    this.transientSessionValues.set(state.definition.name, transientValueSnapshot(state))
    this.message(`Set transient values for ${state.definition.name}`)
    void this.changed("transient-set")
  }

  private async transientSave(): Promise<void> {
    const state = this.transient
    if (!state) {
      this.message("No active transient")
      return
    }
    this.loadTransientSavedValues()
    const snapshot = transientValueSnapshot(state)
    this.transientSessionValues.set(state.definition.name, snapshot)
    this.transientSavedValues.set(state.definition.name, snapshot)
    await this.writeTransientSavedValues()
    this.message(`Saved transient values for ${state.definition.name}`)
    await this.changed("transient-save")
  }

  private async transientReset(): Promise<void> {
    const state = this.transient
    if (!state) {
      this.message("No active transient")
      return
    }
    this.loadTransientSavedValues()
    this.transientSessionValues.delete(state.definition.name)
    const hadSaved = this.transientSavedValues.delete(state.definition.name)
    state.values = transientDefaultValues(state.definition)
    state.historyIndex = null
    if (hadSaved || this.transientSavedValuesFileExists) await this.writeTransientSavedValues()
    this.message(`Reset transient values for ${state.definition.name}`)
    await this.changed("transient-reset")
  }

  private transientHistoryCycle(direction: "prev" | "next"): void {
    const state = this.transient
    if (!state) {
      this.message("No active transient")
      return
    }
    const history = this.transientHistory.get(state.definition.name) ?? []
    if (!history.length) {
      this.message(`No transient history for ${state.definition.name}`)
      return
    }
    const nextIndex = direction === "prev"
      ? state.historyIndex == null ? 0 : (state.historyIndex + 1) % history.length
      : state.historyIndex == null ? history.length - 1 : (state.historyIndex - 1 + history.length) % history.length
    state.historyIndex = nextIndex
    applyTransientValueSnapshot(state.definition, state.values, history[nextIndex]!)
    this.message(`Transient history ${nextIndex + 1}/${history.length}`)
    void this.changed(`transient-history-${direction}`)
  }

  private pushTransientHistory(name: string, snapshot: TransientValueSnapshot): void {
    const history = this.transientHistory.get(name) ?? []
    history.unshift(snapshot)
    if (history.length > TRANSIENT_HISTORY_LIMIT) history.length = TRANSIENT_HISTORY_LIMIT
    this.transientHistory.set(name, history)
  }

  private transientValuesFile(): string {
    return getCustom<string>("transient-values-file") ?? join(homedir(), ".jemacs", "transient.json")
  }

  private loadTransientSavedValues(): void {
    const file = this.transientValuesFile()
    if (this.transientSavedValuesFile === file) return
    this.transientSavedValuesFile = file
    this.transientSavedValues = new Map()
    this.transientSavedValuesFileExists = false
    let text: string
    try {
      text = readFileSync(file, "utf8")
      this.transientSavedValuesFileExists = true
    } catch {
      return
    }
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      return
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return
    for (const [name, value] of Object.entries(data)) {
      const snapshot = parseTransientValueSnapshot(value)
      if (snapshot) this.transientSavedValues.set(name, snapshot)
    }
  }

  private async writeTransientSavedValues(): Promise<void> {
    const file = this.transientValuesFile()
    if (!this.transientSavedValues.size) {
      await unlink(file).catch(() => undefined)
      this.transientSavedValuesFile = file
      this.transientSavedValuesFileExists = false
      return
    }
    const data: Record<string, TransientValueSnapshot> = {}
    for (const [name, snapshot] of this.transientSavedValues) data[name] = snapshot
    await mkdir(dirname(file), { recursive: true })
    await writeFileText(file, JSON.stringify(data, null, 2))
    this.transientSavedValuesFile = file
    this.transientSavedValuesFileExists = true
  }

  private transientQuitOne(message = "Quit", clearPrefix = true): void {
    if (clearPrefix) this.prefixArg.clear()
    this.transient = this.transientStack.pop() ?? null
    if (!this.transient && message) this.message(message)
  }

  private transientQuitAll(message = "Quit", clearPrefix = true): void {
    if (clearPrefix) this.prefixArg.clear()
    this.transient = null
    this.transientStack.length = 0
    if (message) this.message(message)
  }

  private suspendTransient(): void {
    if (!this.transient) return
    this.suspendedTransient = { active: this.transient, stack: [...this.transientStack] }
    this.transient = null
    this.transientStack.length = 0
  }

  private formatTransient(state: TransientState): TransientDisplay {
    const { definition, values } = state
    const lines: TransientLine[] = [transientHeadingLine(definition.title)]
    if (state.pending.length || this.prefixArg.isActive()) {
      lines.push(transientPendingLine(state.pending, this.prefixArg.peek()))
      if (normalizeSequence(state.pending.join(" ")) === "C-x") {
        lines.push(transientCommonLine())
      }
    }
    for (const group of definition.groups) {
      if (!transientGroupVisible(state, group)) continue
      // Emacs `transient--insert-groups` only emits groups that have visible
      // children, so a group whose every entry is hidden by a predicate leaves
      // no heading and no blank separator behind.
      const body = transientGroupLines(state, group, values)
      if (!body.length) continue
      lines.push(transientPlainLine(""))
      const title = transientText(group.title)
      if (title) lines.push(transientHeadingLine(title))
      lines.push(...body)
    }
    return transientDisplayFromLines(lines)
  }

  indentLine(buffer = this.activeBuffer): void {
    const indent = modeSystem.modeFeature(buffer.mode, "indentLine")
    if (indent) indent(buffer)
    else buffer.insert("  ")
    void this.changed("indent-line")
  }

  async completeAtPoint(buffer = this.activeBuffer): Promise<boolean> {
    const lspCandidates = await this.lsp?.completionAtPoint(buffer) ?? []
    if (lspCandidates.length) return this.applyCompletionCandidates(buffer, lspCandidates)

    const complete = modeSystem.modeFeature(buffer.mode, "completeAtPoint")
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

  fontLock(buffer = this.currentBuffer, range?: FontLockRange): TextSpan[] {
    if (buffer.locals.get(LARGE_FILE_LOADING_LOCAL)) return []
    if (buffer.locals.get(LARGE_FILE_LITERAL_LOCAL)) return []
    const fontLock = modeSystem.modeFeature(buffer.mode, "fontLock")
    const cached = this.fontLockCache.get(buffer)
    const key = range ? `${range.start}:${range.end}` : "all"
    let spans: TextSpan[]
    if (cached && cached.text === buffer.text && cached.key === key) spans = cached.spans
    else {
      try {
        spans = fontLock?.(buffer, range) ?? []
      } catch (err) {
        if (process.env.JEMACS_DEBUG_FONT_LOCK === "1") {
          console.error(`font-lock for mode '${buffer.mode}' threw:`, err)
        }
        spans = []
      }
      this.fontLockCache.set(buffer, { text: buffer.text, key, spans })
    }
    const lspSpans = this.lsp?.diagnosticSpans(buffer) ?? []
    const overlaySpans = this.overlaySources.flatMap(src => src(buffer))
    if (!lspSpans.length && !overlaySpans.length) return spans
    return [...spans, ...lspSpans, ...overlaySpans]
  }

  /** Register a span producer consulted on every render (minor-mode overlays
   *  like smerge/show-paren) — kept out of the text-keyed font-lock cache. */
  addOverlaySource(fn: (buffer: BufferModel) => TextSpan[]): () => void {
    this.overlaySources.push(fn)
    return () => {
      const index = this.overlaySources.indexOf(fn)
      if (index >= 0) this.overlaySources.splice(index, 1)
    }
  }

  /** Register one-based line decorations rendered in the line-number gutter. */
  addGutterDecorationSource(fn: (buffer: BufferModel) => GutterDecoration[]): () => void {
    this.gutterDecorationSources.push(fn)
    return () => {
      const index = this.gutterDecorationSources.indexOf(fn)
      if (index >= 0) this.gutterDecorationSources.splice(index, 1)
    }
  }

  gutterDecorations(buffer: BufferModel): GutterDecoration[] {
    return this.gutterDecorationSources
      .flatMap(source => source(buffer))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  }

  setTheme(theme: Theme): void {
    this.baseTheme = theme
    this.theme = composeTheme(theme)
    void this.changed("theme")
  }

  refreshComposedTheme(): void {
    this.theme = composeTheme(this.baseTheme)
    void this.changed("theme")
  }

  /** @deprecated Compat shim — call `mutateWindowLayout` with `splitWindowLeaf`, or `run("split-window-below")`. */
  splitWindowBelow(): void { void this.splitSelectedWindow("vertical") }
  /** @deprecated Compat shim — call `mutateWindowLayout` with `splitWindowLeaf`, or `run("split-window-right")`. */
  splitWindowRight(): void { void this.splitSelectedWindow("horizontal") }

  setWindowSplitRatio(windowId: string, ratio: number): void {
    this.mutateWindowLayout(layout => setWindowSplitRatioForLeaf(layout, windowId, ratio), "set-window-split-ratio")
  }

  private splitSelectedWindow(orientation: "vertical" | "horizontal"): string {
    const buffer = this.currentBuffer
    const startLine = this.selectedWindowLeaf()?.startLine ?? 0
    let newId = this.selectedWindowId
    this.mutateWindowLayout(layout => {
      const r = splitWindowLeaf(layout, this.selectedWindowId, orientation, buffer.id, buffer.point)
      newId = r.newWindowId
      return setWindowLeafStartLine(r.layout, newId, startLine)
    })
    void this.changed(`split-window-${orientation === "vertical" ? "below" : "right"}`)
    return newId
  }

  /** @deprecated Compat shim — call `mutateWindowLayout` with `deleteOtherWindowLeaves`, or `run("delete-other-windows")`. */
  deleteOtherWindows(): void {
    if (listWindowLeaves(this.windowLayout).length <= 1) return
    this.mutateWindowLayout(layout => deleteOtherWindowLeaves(layout, this.selectedWindowId), "delete-other-windows")
  }

  /** @deprecated Compat shim — call `mutateWindowLayout` with `balanceWindowTree`, or `run("balance-windows")`. */
  balanceWindows(): void {
    this.mutateWindowLayout(balanceWindowTree, "balance-windows")
  }

  /** @deprecated Compat shim — call `mutateWindowLayout` with `deleteWindowLeaf`, or `run("delete-window")`. */
  deleteWindow(): void {
    if (listWindowLeaves(this.windowLayout).length <= 1) return
    const next = nextWindowId(this.windowLayout, this.selectedWindowId, 1)
    this.mutateWindowLayout(layout => {
      const result = deleteWindowLeaf(layout, this.selectedWindowId) ?? layout
      this.selectedWindowId = findWindowLeaf(result, next) ? next : listWindowLeaves(result)[0]!.id
      return result
    }, "delete-window")
  }

  killBuffer(bufferOrId?: BufferModel | string): BufferModel | null {
    const target = bufferOrId
      ? (typeof bufferOrId === "string"
          ? (this.buffers.get(bufferOrId) ?? [...this.buffers.values()].find(b => b.name === bufferOrId || this.displayNames.get(b.id) === bufferOrId))
          : bufferOrId)
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
    this.removeBufferFromWindowHistories(target.id)
    this.uniquifyBufferNames()
    this.windowLayout = removeBufferFromWindows(this.windowLayout, target.id, fallbackId)
    if (findWindowLeaf(this.windowLayout, this.selectedWindowId) == null) {
      this.selectedWindowId = listWindowLeaves(this.windowLayout)[0]!.id
    }
    // Saved tab configurations hold their own window trees, so a killed buffer
    // survives there until the tab is selected again. Patch them all now.
    this.replaceBufferInTabs(target.id, fallbackId)
    if (this.currentBufferId === target.id) this.switchToBuffer(fallbackId)
    void this.runHook("kill-buffer-hook", target)
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
    this.autoSaveTimer = setInterval(() => void this.doAutoSave(), 30_000)
  }

  stopAutoSave(): void {
    if (this.autoSaveTimer) clearInterval(this.autoSaveTimer)
    this.autoSaveTimer = null
  }

  /** Write `#file#` for every dirty file-visiting buffer. */
  async doAutoSave(): Promise<number> {
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
    const [autoStat, fileStat] = await Promise.all([stat(target), stat(buffer.path)])
    if (autoStat && fileStat && autoStat.mtime <= fileStat.mtime) {
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
    const match = state.direction === 1
      ? findRestrictedMatchForward(buffer, state.string, buffer.point, state.regexp ?? false)
      : findRestrictedMatchBackward(buffer, state.string, buffer.point, state.regexp ?? false)
    if (match == null) {
      this.message(`Search failed: ${state.string}`)
      return
    }
    this.applyIsearchMatch(buffer, state, match)
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

  setIsearchString(string: string): void {
    const state = this.isearch
    if (!state) return
    const buffer = this.buffers.get(state.bufferId)
    if (!buffer) return
    state.string = string
    if (!string) {
      buffer.point = state.startPoint
      state.match = undefined
      this.message(isearchPrompt(state))
      void this.changed("isearch-input")
      return
    }
    const match = state.direction === 1
      ? findRestrictedMatchForward(buffer, string, state.startPoint, state.regexp ?? false)
      : findRestrictedMatchBackward(buffer, string, state.startPoint, state.regexp ?? false)
    if (match == null) {
      state.match = undefined
      this.message(`Failing I-search: ${string}`)
      void this.changed("isearch-fail")
      return
    }
    this.applyIsearchMatch(buffer, state, match)
    this.message(isearchPrompt(state))
    void this.changed("isearch-input")
  }

  applyIsearchMatch(buffer: BufferModel, state: IsearchState, match: IsearchMatch): void {
    state.match = match
    buffer.point = state.direction === 1 ? match.end : match.start
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
    if (request.dynamicCollection) return await this.queryDynamicCollection(this.minibufferInput()) ?? []
    if (request.completion === "file") {
      return fileCompletionCandidates(this.minibufferInput(), request.fileCompletionDirectory ?? process.cwd())
    }
    return request.collection ?? []
  }

  /**
   * Run the active request's `dynamicCollection`, aborting whichever query is still in flight.
   *
   * Returns null when the result must be discarded -- the prompt closed, or a newer keystroke
   * already started another query -- so callers never paint candidates for stale input.
   */
  async queryDynamicCollection(input: string): Promise<string[] | null> {
    const request = this.minibuffer
    if (!request?.dynamicCollection) return null
    this.dynamicCollectionAbort?.abort()
    const controller = new AbortController()
    this.dynamicCollectionAbort = controller
    let candidates: string[]
    try {
      candidates = await request.dynamicCollection(input, controller.signal)
    } catch {
      return null
    }
    if (controller.signal.aborted || this.minibuffer !== request) return null
    if (this.dynamicCollectionAbort === controller) this.dynamicCollectionAbort = null
    return candidates
  }

  /** Incremental completion (icomplete-style) while typing in the minibuffer. */
  async refreshMinibufferCompletions(): Promise<void> {
    const request = this.minibuffer
    if (!request) return
    if (this.minibufferCompletionFrontend?.refresh) {
      await this.minibufferCompletionFrontend.refresh(this)
      return
    }
    const text = this.minibufferInput()
    if (request.dynamicCollection) {
      const candidates = await this.queryDynamicCollection(text)
      // The source already matched and ranked; filtering again would drop its results.
      if (candidates && candidates.length > 1) this.showCompletions(candidates)
      return
    }
    const collection = request.collection
    if (!collection?.length) return
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
      : request.dynamicCollection
        ? await this.queryDynamicCollection(input) ?? []
        : request.collection ?? []
    if (!collection.length) return

    // Dynamic candidates arrive pre-matched, so completion only extends the input to their
    // common prefix instead of re-running a matcher the source did not use.
    const matches = request.dynamicCollection
      ? collection
      : this.completer
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
    const keyDescription = emacsKeyDescription(sequence)
    if (!described) return `${keyDescription} is undefined`
    const command = this.commands.get(described.command)
    const description = command?.description ? `\n\n${command.description}` : ""
    return `${emacsKeyDescription(described.sequence)} runs the command ${described.command} (found in ${described.mapName}).${description}`
  }

  describeKeyBriefly(sequence: string): string {
    const described = this.keymaps.describe(sequence)
    const keyDescription = emacsKeyDescription(sequence)
    if (!described) return `${keyDescription} is undefined`
    return `${emacsKeyDescription(described.sequence)} runs the command ${described.command}`
  }

  message(text: string): string {
    this.lastEchoMessage = text
    const msg = [...this.buffers.values()].find(b => b.name === "*messages*")
    if (msg) {
      msg.append(`${new Date().toISOString()}  ${text}\n`)
      msg.point = msg.text.length
    }
    void this.events.emit("message", { text })
    void this.changed("message")
    return text
  }

  clearMessage(): void {
    if (!this.lastEchoMessage) return
    this.lastEchoMessage = ""
    void this.events.emit("message", { text: "" })
    void this.changed("message-clear")
  }

  async changed(reason: string): Promise<void> {
    await this.events.emit("changed", { reason })
  }

  async quit(): Promise<void> {
    this.stopAutoSave()
    // runtime/ registers a kill-emacs-hook that disposes plugin contexts, so the
    // kernel sheds auto-save/eldoc/watchman timers without importing runtime/.
    await this.runHook("kill-emacs-hook", this.currentBuffer)
    this.running = false
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
    for (const keymap of pointKeymaps(this.currentBuffer, this.currentBuffer.point)) {
      maps.push({ name: keymap.name, keymap })
    }
    for (const mode of modeSystem.modeLineage(this.currentBuffer.mode)) {
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

function shouldOpenLiterally(size: number | undefined): boolean {
  if (size == null) return false
  const threshold = getCustom<number>("large-file-warning-threshold") ?? LARGE_FILE_WARNING_THRESHOLD
  return threshold > 0 && size > threshold
}

const TRANSIENT_HISTORY_LIMIT = 10
const TRANSIENT_ENGINE_BINDINGS = new Map<string, TransientEngineCommand>([
  ["C-x s", "transient-set"],
  ["C-x C-s", "transient-save"],
  ["C-x C-r", "transient-reset"],
  ["C-x p", "transient-history-prev"],
  ["C-x n", "transient-history-next"],
])

defface("transient-heading", { inherit: ["keyword"], bold: true }, "Face for transient popup headings.", "transient")
defface("transient-key", { inherit: ["builtin"], bold: true }, "Face for transient keys.", "transient")
defface("transient-argument", { inherit: ["string"], bold: true }, "Face for enabled transient arguments.", "transient")
defface("transient-inactive-argument", { inherit: ["comment"] }, "Face for disabled transient arguments.", "transient")
defface("transient-value", { inherit: ["string"] }, "Face for transient values.", "transient")
defface("transient-inapt-suffix", { inherit: ["comment"], italic: true }, "Face for inapplicable transient suffixes.", "transient")

const TRANSIENT_HEADING_FACE = "transient-heading" as TextSpan["face"]
const TRANSIENT_KEY_FACE = "transient-key" as TextSpan["face"]
const TRANSIENT_ARGUMENT_FACE = "transient-argument" as TextSpan["face"]
const TRANSIENT_INACTIVE_ARGUMENT_FACE = "transient-inactive-argument" as TextSpan["face"]
const TRANSIENT_VALUE_FACE = "transient-value" as TextSpan["face"]
const TRANSIENT_INAPT_FACE = "transient-inapt-suffix" as TextSpan["face"]
/** Emacs `transient--column-stops` reduces column widths with a `(+ 2 ...)` seed,
 *  so adjacent columns are separated by exactly two spaces. */
const TRANSIENT_COLUMN_PADDING = 2

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MiB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GiB`
}

function transientEngineCommand(key: string): TransientEngineCommand | undefined {
  return TRANSIENT_ENGINE_BINDINGS.get(normalizeSequence(key))
}

function transientEngineHasPrefix(key: string): boolean {
  const prefix = `${normalizeSequence(key)} `
  for (const sequence of TRANSIENT_ENGINE_BINDINGS.keys()) {
    if (sequence.startsWith(prefix)) return true
  }
  return false
}

type TransientResolved<T extends TransientInfix | TransientSuffix> = {
  item: T
  inapt: boolean
}

type TransientLine = {
  text: string
  spans: TextSpan[]
}

type TransientLineBuilder = {
  line: TransientLine
  append: (text: string, face?: TextSpan["face"]) => void
  appendLine: (line: TransientLine) => void
}

function transientInfix(state: TransientState, key: string): TransientResolved<TransientInfix> | undefined {
  const normalized = normalizeSequence(key)
  for (const group of transientVisibleGroups(state)) {
    for (const infix of group.infixes ?? []) {
      if (!transientItemVisible(state, infix)) continue
      if (normalizeSequence(infix.key) === normalized) return { item: infix, inapt: transientItemInapt(infix) }
    }
  }
  return undefined
}

function transientSuffix(state: TransientState, key: string): TransientResolved<TransientSuffix> | undefined {
  const normalized = normalizeSequence(key)
  for (const group of transientVisibleGroups(state)) {
    for (const suffix of group.suffixes ?? []) {
      if (!transientItemVisible(state, suffix)) continue
      if (normalizeSequence(suffix.key) === normalized) return { item: suffix, inapt: transientItemInapt(suffix) }
    }
  }
  return undefined
}

function transientHasPrefix(state: TransientState, key: string): boolean {
  const prefix = `${normalizeSequence(key)} `
  for (const group of transientVisibleGroups(state)) {
    for (const infix of group.infixes ?? []) {
      if (transientItemVisible(state, infix) && normalizeSequence(infix.key).startsWith(prefix)) return true
    }
    for (const suffix of group.suffixes ?? []) {
      if (transientItemVisible(state, suffix) && normalizeSequence(suffix.key).startsWith(prefix)) return true
    }
  }
  return false
}

function* transientVisibleGroups(state: TransientState, groups: TransientGroup[] = state.definition.groups): Generator<TransientGroup> {
  for (const group of groups) {
    if (!transientGroupVisible(state, group)) continue
    yield group
    if (group.subgroups?.length) yield* transientVisibleGroups(state, group.subgroups)
  }
}

function transientGroupVisible(state: TransientState, group: TransientGroup): boolean {
  return transientLevelVisible(group.level, transientActiveLevel(state.definition)) && group.if?.() !== false
}

function transientItemVisible(state: TransientState, item: TransientInfix | TransientSuffix): boolean {
  return transientLevelVisible(item.level, transientActiveLevel(state.definition)) && item.if?.() !== false
}

function transientItemInapt(item: TransientInfix | TransientSuffix): boolean {
  return item.inaptIf?.() === true
}

function transientLevelVisible(level: number | undefined, activeLevel: number): boolean {
  return level == null || level <= activeLevel
}

function transientActiveLevel(definition: TransientDefinition): number {
  const raw = definition.defaultLevel ?? getCustom<number>("transient-default-level") ?? 4
  if (!Number.isFinite(raw)) return 4
  return Math.max(1, Math.min(7, Math.floor(raw)))
}

function transientDefaultValues(definition: TransientDefinition): Map<string, TransientValue> {
  const values = new Map<string, TransientValue>()
  for (const infix of transientAllInfixes(definition)) values.set(infix.argument, infix.defaultValue ?? false)
  return values
}

function transientValueSnapshot(state: TransientState): TransientValueSnapshot {
  const snapshot: TransientValueSnapshot = {}
  for (const infix of transientAllInfixes(state.definition)) snapshot[infix.argument] = state.values.get(infix.argument) ?? false
  return snapshot
}

function applyTransientValueSnapshot(definition: TransientDefinition, values: Map<string, TransientValue>, snapshot: TransientValueSnapshot): void {
  for (const infix of transientAllInfixes(definition)) {
    if (Object.hasOwn(snapshot, infix.argument)) values.set(infix.argument, snapshot[infix.argument]!)
  }
}

function parseTransientValueSnapshot(value: unknown): TransientValueSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const snapshot: TransientValueSnapshot = {}
  for (const [argument, entry] of Object.entries(value)) {
    if (typeof entry === "boolean" || typeof entry === "string") snapshot[argument] = entry
  }
  return snapshot
}

function transientArguments(state: TransientState): string[] {
  const args: string[] = []
  for (const group of transientVisibleGroups(state)) {
    for (const infix of group.infixes ?? []) {
      if (!transientItemVisible(state, infix) || transientItemInapt(infix)) continue
      const value = state.values.get(infix.argument)
      if (value === true) args.push(infix.argument)
      else if (typeof value === "string" && value) {
        if (infix.style === "equals") args.push(`${infix.argument}=${value}`)
        else args.push(infix.argument, value)
      }
    }
  }
  return args
}

/** Emacs transient `:incompatible`: activating an argument deactivates every other argument
 *  listed in the same mutually exclusive set. Deactivating an argument affects nothing. */
function transientEnforceIncompatible(definition: TransientDefinition, values: Map<string, TransientValue>, changedArgument: string): void {
  if (!transientValueActive(values.get(changedArgument))) return
  for (const set of definition.incompatible ?? []) {
    if (!set.includes(changedArgument)) continue
    for (const argument of set) {
      if (argument !== changedArgument) values.set(argument, false)
    }
  }
}

function transientValueActive(value: TransientValue | undefined): boolean {
  return value === true || (typeof value === "string" && value !== "")
}

function* transientAllInfixes(definition: TransientDefinition): Generator<TransientInfix> {
  yield* transientAllGroupInfixes(definition.groups)
}

function* transientAllGroupInfixes(groups: TransientGroup[]): Generator<TransientInfix> {
  for (const group of groups) {
    yield* (group.infixes ?? [])
    if (group.subgroups?.length) yield* transientAllGroupInfixes(group.subgroups)
  }
}

function transientPlainLine(text: string): TransientLine {
  return { text, spans: [] }
}

function transientHeadingLine(text: string): TransientLine {
  const line = transientPlainLine(text)
  if (text) line.spans.push({ start: 0, end: text.length, face: TRANSIENT_HEADING_FACE })
  return line
}

/** Resolve an Emacs `:description`, which may be a literal string or a thunk evaluated at
 *  redisplay time. A thunk must never break redisplay, so a throwing thunk yields "". */
function transientText(value: TransientText): string {
  if (typeof value === "string") return value
  try {
    return value()
  } catch {
    return ""
  }
}

function transientPendingLine(pending: string[], prefixArgument: number | null): TransientLine {
  const b = transientLineBuilder()
  b.append("-- ")
  if (pending.length) {
    b.append("pending: ")
    b.append(pending.join(" "), TRANSIENT_KEY_FACE)
    b.append(" ")
  }
  if (prefixArgument != null) {
    if (pending.length) b.append(" ")
    b.append("prefix: ")
    b.append(String(prefixArgument), TRANSIENT_VALUE_FACE)
    b.append(" ")
  }
  return b.line
}

function transientCommonLine(): TransientLine {
  const b = transientLineBuilder()
  const entries: Array<[string, string]> = [
    ["C-x s", "set"],
    ["C-x C-s", "save"],
    ["C-x C-r", "reset"],
    ["C-x p", "previous"],
    ["C-x n", "next"],
  ]
  b.append("Common: ")
  entries.forEach(([key, label], index) => {
    if (index > 0) b.append("  ")
    b.append(key, TRANSIENT_KEY_FACE)
    b.append(` ${label}`)
  })
  return b.line
}

/**
 * Emacs `transient--maybe-pad-keys`: a group only pads its keys to a common
 * width when it (or its parent) sets `pad-keys`; the default is nil, so keys
 * render at their natural width.
 */
function transientKeyWidth(state: TransientState, group: TransientGroup, inherited: boolean): number {
  if (!(group.padKeys ?? inherited)) return 0
  let width = 0
  for (const infix of group.infixes ?? []) {
    if (transientItemVisible(state, infix)) width = Math.max(width, infix.key.length)
  }
  for (const suffix of group.suffixes ?? []) {
    if (transientItemVisible(state, suffix)) width = Math.max(width, suffix.key.length)
  }
  return width
}

function transientGroupLines(state: TransientState, group: TransientGroup, values: Map<string, TransientValue>, inheritedPadKeys = false): TransientLine[] {
  const lines: TransientLine[] = []
  const padKeys = group.padKeys ?? inheritedPadKeys
  const keyWidth = transientKeyWidth(state, group, inheritedPadKeys)
  for (const infix of group.infixes ?? []) {
    if (!transientItemVisible(state, infix)) continue
    lines.push(transientInfixLine(infix, values.get(infix.argument), transientItemInapt(infix), keyWidth))
  }
  for (const suffix of group.suffixes ?? []) {
    if (!transientItemVisible(state, suffix)) continue
    lines.push(transientSuffixLine(suffix, transientItemInapt(suffix), keyWidth))
  }
  const columns = (group.subgroups ?? [])
    .filter(subgroup => transientGroupVisible(state, subgroup))
    .map(subgroup => {
      const body = transientGroupLines(state, subgroup, values, padKeys)
      const title = transientText(subgroup.title)
      return title ? [transientHeadingLine(title), ...body] : body
    })
  if (columns.length) lines.push(...transientColumnLines(columns))
  return lines
}

/**
 * Emacs renders an infix from its class `format` slot:
 *   `transient-switch` / `transient-option` -> `" %k %d (%v)"`
 *   `transient-variable`                    -> `" %k %d %v"`
 * `%v` comes from `transient-format-value`, which shows the argument in
 * `transient-argument` when active and `transient-inactive-argument` when not.
 * Keys are not padded unless a group sets `pad-keys` (default nil).
 */
function transientInfixLine(infix: TransientInfix, value: TransientValue | undefined, inapt: boolean, keyWidth: number): TransientLine {
  const b = transientLineBuilder()
  b.append(" ")
  b.append(infix.key.padEnd(keyWidth), TRANSIENT_KEY_FACE)
  b.append(" ")
  b.append(transientText(infix.label))
  if (infix.formatValue) {
    // Emacs classes may override `transient-format-value` outright; an empty
    // result contributes nothing but the separating space, exactly as the
    // `" %k %d %v"` format spec does.
    const formatted = infix.formatValue(typeof value === "string" && value ? value : null)
    b.append(" ")
    if (formatted) b.append(formatted, TRANSIENT_VALUE_FACE)
    if (inapt) markTransientLineInapt(b.line)
    return b.line
  }
  b.append(" ")
  if (infix.kind === "variable") appendTransientVariableValue(b, value)
  else {
    b.append("(")
    appendTransientInfixValue(b, infix, value)
    b.append(")")
  }
  if (inapt) markTransientLineInapt(b.line)
  return b.line
}

/** Emacs `transient-suffix` renders as `" %k %d"`. */
function transientSuffixLine(suffix: TransientSuffix, inapt: boolean, keyWidth: number): TransientLine {
  const b = transientLineBuilder()
  b.append(" ")
  b.append(suffix.key.padEnd(keyWidth), TRANSIENT_KEY_FACE)
  b.append(" ")
  b.append(transientText(suffix.label))
  if (inapt) markTransientLineInapt(b.line)
  return b.line
}

/**
 * Emacs `transient-format-value`: a switch shows just its argument, faced by
 * whether it is active. An option with a value shows `argument` + `value`
 * (the argument already carries its trailing `=` when it takes one), and falls
 * back to the bare inactive argument when unset.
 */
function appendTransientInfixValue(builder: TransientLineBuilder, infix: TransientInfix, value: TransientValue | undefined): void {
  if ((infix.kind ?? "toggle") === "value" || infix.choices?.length) {
    if (typeof value === "string" && value) {
      builder.append(infix.argument, TRANSIENT_ARGUMENT_FACE)
      if (infix.style !== "equals" && !infix.argument.endsWith("=")) builder.append(" ", TRANSIENT_ARGUMENT_FACE)
      builder.append(value, TRANSIENT_VALUE_FACE)
      return
    }
    builder.append(infix.argument, TRANSIENT_INACTIVE_ARGUMENT_FACE)
    return
  }
  builder.append(infix.argument, value === true ? TRANSIENT_ARGUMENT_FACE : TRANSIENT_INACTIVE_ARGUMENT_FACE)
}

/** Emacs `transient-lisp-variable` prints its value with `prin1` in `transient-value`. */
function appendTransientVariableValue(builder: TransientLineBuilder, value: TransientValue | undefined): void {
  const printed = typeof value === "string" && value ? `"${value}"` : "nil"
  builder.append(printed, TRANSIENT_VALUE_FACE)
}

/**
 * Emacs `transient--insert-group` for `transient-columns`: column stops are
 * computed once from the widest cell in each column (`transient--column-stops`,
 * seeded with a `+ 2` gap), then every cell is preceded by padding up to its
 * stop (`transient--align-to`). Padding is only ever inserted *before* a cell,
 * so rows carry no trailing whitespace and headings align with their column.
 */
function transientColumnLines(columns: TransientLine[][]): TransientLine[] {
  if (!columns.length) return []
  const height = Math.max(0, ...columns.map(column => column.length))
  const stops: number[] = []
  let stop = 0
  for (const column of columns) {
    stops.push(stop)
    stop += Math.max(0, ...column.map(line => line.text.length)) + TRANSIENT_COLUMN_PADDING
  }
  const lines: TransientLine[] = []
  for (let row = 0; row < height; row++) {
    const b = transientLineBuilder()
    for (let col = 0; col < columns.length; col++) {
      const cell = columns[col]![row]
      if (!cell || !cell.text) continue
      const pad = stops[col]! - b.line.text.length
      if (pad > 0) b.append(" ".repeat(pad))
      b.appendLine(cell)
    }
    lines.push(b.line)
  }
  return lines
}

function transientDisplayFromLines(lines: TransientLine[]): TransientDisplay {
  let text = ""
  const spans: TextSpan[] = []
  let offset = 0
  lines.forEach((line, index) => {
    if (index > 0) {
      text += "\n"
      offset++
    }
    for (const span of line.spans) spans.push({ ...span, start: offset + span.start, end: offset + span.end })
    text += line.text
    offset += line.text.length
  })
  return { text, spans }
}

function transientLineBuilder(): TransientLineBuilder {
  const line: TransientLine = { text: "", spans: [] }
  return {
    line,
    append(text: string, face?: TextSpan["face"]) {
      if (!text) return
      const start = line.text.length
      line.text += text
      if (face) line.spans.push({ start, end: line.text.length, face })
    },
    appendLine(source: TransientLine) {
      const start = line.text.length
      line.text += source.text
      for (const span of source.spans) {
        line.spans.push({ ...span, start: start + span.start, end: start + span.end })
      }
    },
  }
}

function markTransientLineInapt(line: TransientLine): void {
  if (line.text.length) line.spans.push({ start: 0, end: line.text.length, face: TRANSIENT_INAPT_FACE })
}

function findRestrictedMatchForward(buffer: BufferModel, string: string, from: number, regexp: boolean): IsearchMatch | null {
  const match = findMatchForward(buffer.text, string, Math.max(buffer.pointMin, from), regexp)
  if (!match || match.end > buffer.pointMax) return null
  return match
}

function findRestrictedMatchBackward(buffer: BufferModel, string: string, before: number, regexp: boolean): IsearchMatch | null {
  const match = findMatchBackward(buffer.text, string, Math.min(buffer.pointMax, before), regexp)
  if (!match || match.start < buffer.pointMin) return null
  return match
}
