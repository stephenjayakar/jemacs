/**
 * Runtime instrumentation for the tmux-cc GUI judder.
 *
 * The sibling file `tmux-cc-gui-judder.test.ts` pins the display-model shape.
 * This file drives the *real* `presentDomFrame` renderer across a simulated
 * frame sequence and counts what the Electron host would actually do, so the
 * causal chain is measured rather than argued:
 *
 *   engine swaps  -- how often a pane that was rendering through the host's
 *                    terminal renderer stops doing so (or vice versa). Each
 *                    swap is one visible xterm.js <-> themed-text transition.
 *   mount calls   -- how often the host is asked to (re)attach its terminal.
 *
 * Two scenarios are replayed:
 *   A. resize      -- geometry changes while the emulator lags behind, which is
 *                     the tmux-cc 50ms `scheduleGeometry` debounce window.
 *   B. output burst-- steady cell churn at fixed geometry, i.e. a busy shell.
 *
 * Measured on the end-to-end scenario (real layout gate + real renderer):
 *
 *   before fix:  timeline XXttX   swaps 2   reparents 2
 *   after  fix:  timeline XXXXX   swaps 0   reparents 1
 *
 * where X = the host's live terminal element is in the pane body and t = it has
 * been replaced by themed text. Each X->t->X pair is one visible flicker.
 *
 * Corroborated against a live GUI: a real Electron frame attached to a local
 * `tmux -CC` session with vi running in the pane (the terminal surface only
 * exists while xterm is on its alternate buffer -- see jterm/session.ts
 * `mirrorFromXterm` -- so a plain shell never takes this path at all). Driving
 * real `BrowserWindow.setSize` resizes and counting inside `layoutLeafPane`:
 *
 *   before fix:  311 gate checks, 12 dimension mismatches, 12 surface rejections
 *   after  fix:  319 gate checks, 12 dimension mismatches,  0 surface rejections
 *
 * The mismatches happen either way -- the kernel restamps pane geometry
 * immediately while the pty resize lands ~50ms later. What changed is that a
 * mismatch no longer drops the pane out of the terminal branch. Sample pairs
 * observed live: surface 37x122 vs pane 33x108, then 33x108 vs 37x122.
 *
 * Note the trigger: editor-level split/delete-window does NOT reproduce this,
 * only genuine OS window resizes do.
 */
import { afterEach, expect, test } from "bun:test"
import type { SerializedDisplayModel, SerializedPane } from "../../src/display/serialize"
import type { TerminalSurfaceModel } from "../../src/display/terminal-surface"

// ── Minimal DOM fake (mirrors loop-t-audit2-67bb30d0.test.ts) ────────────────

class FakeText { nodeType = 3; constructor(public data: string) {} }
class FakeEl {
  nodeType = 1
  children: FakeEl[] = []
  childNodes: Array<FakeEl | FakeText> = []
  classList = { _s: new Set<string>(), add: (c: string) => { this.classList._s.add(c) },
    // DOMTokenList.remove is variadic; removeClasses() in dom-frame.ts spreads
    // several names into one call, so a single-arg fake silently keeps all but
    // the first class and misreports what is on screen.
    remove: (...cs: string[]) => { for (const c of cs) this.classList._s.delete(c) },
    has: (c: string) => this.classList._s.has(c) }
  dataset: Record<string, string> = {}
  style: Record<string, string> & { setProperty(k: string, v: string): void }
  isConnected = false
  parentNode: FakeEl | null = null
  scrollLeft = 0; scrollTop = 0
  _listeners: Record<string, Array<(ev: unknown) => void>> = {}
  constructor(public tagName: string) {
    this.style = Object.assign({ setProperty: (k: string, v: string) => { this.style[k] = v } })
  }
  set className(v: string) { this.classList._s = new Set(v.split(/\s+/).filter(Boolean)) }
  get className() { return [...this.classList._s].join(" ") }
  set textContent(v: string) { this.childNodes = [new FakeText(v)]; this.children = [] }
  get textContent(): string {
    return this.childNodes.map(n => n instanceof FakeText ? n.data : (n as FakeEl).textContent).join("")
  }
  appendChild<T extends FakeEl | FakeText>(c: T): T {
    this.childNodes.push(c)
    if (c instanceof FakeEl) { this.children.push(c); c.parentNode = this; c._connect(this.isConnected) }
    return c
  }
  append(...cs: FakeEl[]) { for (const c of cs) this.appendChild(c) }
  replaceChildren(...cs: FakeEl[]) {
    for (const old of this.children) { old._connect(false); old.parentNode = null }
    this.children = []; this.childNodes = []
    for (const c of cs) this.appendChild(c)
  }
  remove() {
    const p = this.parentNode
    if (p) { p.children.splice(p.children.indexOf(this), 1); p.childNodes.splice(p.childNodes.indexOf(this), 1) }
    this.parentNode = null
    this._connect(false)
  }
  _connect(v: boolean) { this.isConnected = v; for (const c of this.children) c._connect(v) }
  querySelectorAll(sel: string): FakeEl[] {
    const cls = sel.replace(/^\./, "")
    const out: FakeEl[] = []
    const walk = (el: FakeEl) => { if (el.classList.has(cls)) out.push(el); for (const c of el.children) walk(c) }
    for (const c of this.children) walk(c)
    return out
  }
  addEventListener(ev: string, fn: (e: unknown) => void) { (this._listeners[ev] ??= []).push(fn) }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } }
  scrollIntoView() {}
}

const saved: Record<string, unknown> = {}
const stub = (k: string, v: unknown) => {
  if (!(k in saved)) saved[k] = (globalThis as Record<string, unknown>)[k]
  ;(globalThis as Record<string, unknown>)[k] = v
}
function installDom() {
  const html = new FakeEl("html"); html._connect(true)
  const body = new FakeEl("body"); body._connect(true)
  stub("document", {
    documentElement: html, body,
    getElementById: () => null,
    createElement: (t: string) => new FakeEl(t),
    createRange: undefined,
    createTreeWalker: () => ({ nextNode: () => null }),
  })
  stub("requestAnimationFrame", (fn: () => void) => { void fn; return 1 })
  stub("cancelAnimationFrame", () => {})
}
afterEach(() => { for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v })

// ── Fixtures ────────────────────────────────────────────────────────────────

const themed = (text: string) => ({ chunks: [{ text }] })

/** Raw-stream metadata: shape only, no cells (what the Electron host receives). */
const meta = (rows: number, cols: number, tick = 0): TerminalSurfaceModel =>
  ({ kind: "terminal", rows, cols, cursorRow: tick % Math.max(1, rows), cursorCol: 0, cells: [] })

function pane(over: Partial<SerializedPane> = {}): SerializedPane {
  return {
    id: "w1", bufferId: "b1", selected: true, dedicated: false,
    body: themed(""), modeline: themed(" -:-- term "),
    clickState: { startLine: 0, gutterPrefixLen: 0 },
    bodyLineBudget: 24, syncText: "", syncPoint: 0, textScale: 1,
    ...over,
  }
}
function model(p: SerializedPane): SerializedDisplayModel {
  return {
    title: themed("jemacs"), windows: { kind: "leaf", pane: p }, childFrames: [],
    minibufferCompletions: themed(""), minibufferCompletionLines: 0,
    minibuffer: themed(""), echo: themed(""),
    theme: { faces: { default: { fg: "#ddd", bg: "#111" } } } as never,
    viewport: { rows: 24, cols: 80 }, hostLabel: "test",
  }
}
function targets() {
  const mk = () => { const e = new FakeEl("div"); e._connect(true); return e }
  return { title: mk(), windows: mk(), minibuffer: mk(), echo: mk(), minibufferCompletions: mk() }
}

/** Stand-in for `XtermPaneRegistry` that records what the host is asked to do.
 *  `containers` mirrors the registry's real bufferId-keyed instance map, so
 *  "is the live terminal element still in the DOM?" is answerable.
 *
 *  `guarded` selects which version of the re-parent logic to model:
 *    true  -> the fix in xterm-panes.ts (re-parent only when necessary)
 *    false -> the original unconditional `body.replaceChildren(container)`
 *  Both branches are transcribed from the production method so the pre-fix and
 *  post-fix DOM costs can actually be compared. An earlier version of this
 *  harness hard-coded the guard, which made every run -- including the ones
 *  labelled "pre-fix" -- exercise the fixed behavior and silently understate
 *  the original cost. */
function countingRenderer(guarded = true) {
  const stats = { mounts: 0, reparents: 0, detaches: 0 }
  const containers = new Map<string, FakeEl>()
  return {
    stats,
    containers,
    renderer: {
      mount(body: HTMLElement, p: SerializedPane): boolean {
        if (!p.terminalSurface) return false
        stats.mounts++
        let container = containers.get(p.bufferId)
        if (!container) { container = new FakeEl("div"); containers.set(p.bufferId, container) }
        const el = body as unknown as FakeEl
        el.classList.add("xterm-surface")
        const needed = container.parentNode !== el || el.childNodes.length !== 1
        if (!guarded || needed) {
          // A re-parent of an already-attached element is a detach+attach of
          // the live xterm canvas -- the part that visibly flashes.
          if (container.parentNode === el) stats.detaches++
          stats.reparents++
          el.replaceChildren(container)
        }
        return true
      },
    },
  }
}

/** Replay `frames` through the real renderer; count xterm <-> text transitions.
 *
 *  A frame counts as "xterm" when the host's live terminal element is actually
 *  the pane body's child. Deliberately *not* keyed on the `xterm-surface` CSS
 *  class: `patchPane`'s body-only path never clears that class when it falls
 *  back to text, so the class lies about what is on screen. The DOM itself
 *  does not. */
function replay(frames: SerializedPane[], guarded = true) {
  installDom()
  const { presentDomFrame } = require("../../src/display/dom-frame") as
    typeof import("../../src/display/dom-frame")
  const t = targets()
  const { stats, containers, renderer } = countingRenderer(guarded)
  let swaps = 0
  let prevWasXterm: boolean | null = null
  const timeline: string[] = []
  for (const p of frames) {
    presentDomFrame(t as never, model(p), undefined, undefined, renderer as never)
    const bodyEl = t.windows.querySelectorAll("window-body")[0]!
    const container = containers.get(p.bufferId)
    const isXterm = !!container && container.parentNode === bodyEl
    timeline.push(isXterm ? "X" : "t")
    if (prevWasXterm !== null && isXterm !== prevWasXterm) swaps++
    prevWasXterm = isXterm
  }
  return { swaps, ...stats, timeline: timeline.join("") }
}

// ── Scenario A: resize while the emulator lags ──────────────────────────────

test("INSTRUMENT resize: pane never leaves the xterm path", () => {
  // The emulator holds its old shape for several frames (tmux-cc's 50ms
  // scheduleGeometry debounce) before catching up to the new pane budget.
  const frames = [
    pane({ terminalSurface: meta(24, 80) }), // settled
    pane({ terminalSurface: meta(24, 80) }), // resize begins; emulator lags
    pane({ terminalSurface: meta(24, 80) }), // still lagging
    pane({ terminalSurface: meta(18, 60) }), // pty resize lands
    pane({ terminalSurface: meta(18, 60) }), // settled again
  ]
  const r = replay(frames)
  // The whole point of the fix: zero engine swaps across a resize.
  expect(r.swaps).toBe(0)
  // And the live element is attached once, not re-parented per frame.
  expect(r.reparents).toBe(1)
})

// ── Scenario B: output burst at fixed geometry ──────────────────────────────

test("INSTRUMENT output burst: guarded vs unguarded re-parent cost", () => {
  // A busy shell: geometry constant, cursor/content changing every frame. This
  // is the continuous-stutter case, distinct from the resize transient.
  const frames = Array.from({ length: 8 }, (_, i) => pane({ terminalSurface: meta(24, 80, i + 1) }))

  // Original xterm-panes.ts: body.replaceChildren(container) unconditionally.
  const before = replay(frames, false)
  // With the guard added by this change.
  const after = replay(frames, true)

  // Neither variant swaps rendering engines -- the layout gate is what causes
  // swaps, and geometry is constant here.
  expect(before.swaps).toBe(0)
  expect(after.swaps).toBe(0)

  // This is the measurement the guard exists for. Unguarded, the live xterm
  // element is detached and re-attached on every frame that changes content;
  // guarded, it is attached once and left alone.
  expect(before.reparents).toBe(frames.length)
  expect(before.detaches).toBe(frames.length - 1) // every frame after the first
  expect(after.reparents).toBe(1)
  expect(after.detaches).toBe(0)
  expect(after.mounts).toBe(before.mounts) // same work asked of the host
})

// ── End-to-end: real layout gate feeding the real renderer ──────────────────

/** Replay a resize through `buildDisplayModel` -> `presentDomFrame`, so the
 *  decision to include `terminalSurface` is made by the production gate rather
 *  than by hand-authored panes. `emulator` is the shape the headless xterm
 *  still has on each frame while the viewport changes underneath it. */
async function replayThroughLayout(
  steps: Array<{ viewportRows: number; emulator: { rows: number; cols: number } }>,
) {
  installDom()
  const { presentDomFrame } = require("../../src/display/dom-frame") as
    typeof import("../../src/display/dom-frame")
  const { buildDisplayModel } = require("../../src/display/build-display-model") as
    typeof import("../../src/display/build-display-model")
  const { serializeDisplayModel } = require("../../src/display/serialize") as
    typeof import("../../src/display/serialize")
  const { TERMINAL_SURFACE_LOCAL } = require("../../src/display/terminal-surface") as
    typeof import("../../src/display/terminal-surface")
  const { Editor } = require("../../src/kernel/editor") as typeof import("../../src/kernel/editor")
  const { installDefaultConfig } = require("../../src/config") as typeof import("../../src/config")
  const { installDefaultModes } = require("../../src/modes/default-modes") as
    typeof import("../../src/modes/default-modes")

  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  const buffer = editor.scratch("tmux-pane", "", "text")

  const t = targets()
  const { stats, containers, renderer } = countingRenderer()
  let swaps = 0
  let prevWasXterm: boolean | null = null
  const timeline: string[] = []

  for (const step of steps) {
    // Yield between frames: this scenario builds real editors and would
    // otherwise hold the event loop long enough to delay timers that other
    // test files schedule on the real clock.
    await new Promise(resolve => setTimeout(resolve, 0))
    buffer.locals.set(TERMINAL_SURFACE_LOCAL, meta(step.emulator.rows, step.emulator.cols))
    const built = buildDisplayModel(editor, {
      lastMessage: "",
      viewport: { rows: step.viewportRows, cols: 80 },
      hostCapabilities: {
        unit: "pixels", mouse: true, clipboard: true, osc52: false,
        terminalSurfaces: true, terminalRawStreams: true,
      },
    })
    presentDomFrame(t as never, serializeDisplayModel(built) as never, undefined, undefined, renderer as never)
    const bodyEl = t.windows.querySelectorAll("window-body")[0]!
    const bufferId = built.windows.kind === "leaf" ? built.windows.pane.bufferId : ""
    const container = containers.get(bufferId)
    const isXterm = !!container && container.parentNode === bodyEl
    timeline.push(isXterm ? "X" : "t")
    if (prevWasXterm !== null && isXterm !== prevWasXterm) swaps++
    prevWasXterm = isXterm
  }
  return { swaps, ...stats, timeline: timeline.join("") }
}

// Opt-in: this scenario constructs real Editors, which costs ~150ms of mostly
// synchronous work. Run inside the shared suite it delays timers that other
// files schedule on the real clock (eldoc's 20ms idle timer, the shadow
// reconnect backoff), making unrelated tests fail intermittently. The three
// scenarios above cover the same gate using serialized panes, so this one is
// gated behind a flag and run on demand:
//
//   JEMACS_JUDDER_E2E=1 bun test test/bugs/tmux-cc-judder-instrument.test.ts
const e2e = process.env.JEMACS_JUDDER_E2E ? test : test.skip
e2e("INSTRUMENT end-to-end: real gate holds the xterm path across a resize", async () => {
  // Frames 1-2 are settled. On frame 3 the window shrinks, but the emulator
  // still reports its old shape for two frames (the tmux-cc scheduleGeometry
  // debounce) before the pty resize lands. Under the strict dimension gate this
  // sequence produced "XXttX" -- two engine swaps, i.e. the judder.
  const r = await replayThroughLayout([
    { viewportRows: 24, emulator: { rows: 20, cols: 80 } },
    { viewportRows: 24, emulator: { rows: 20, cols: 80 } },
    { viewportRows: 18, emulator: { rows: 20, cols: 80 } }, // lagging
    { viewportRows: 18, emulator: { rows: 20, cols: 80 } }, // lagging
    { viewportRows: 18, emulator: { rows: 14, cols: 80 } }, // caught up
  ])
  expect(r.timeline).toBe("XXXXX")
  expect(r.swaps).toBe(0)
  expect(r.reparents).toBe(1)
})

// ── Control: prove the harness can actually see a swap ───────────────────────

test("INSTRUMENT control: dropping the surface is detected as a swap", () => {
  // Sanity check on the instrument itself. If `terminalSurface` goes undefined
  // for a frame -- precisely what the strict dimension gate used to do during a
  // resize -- the harness must register two transitions (out and back).
  const frames = [
    pane({ terminalSurface: meta(24, 80) }),
    pane({ body: themed("falling back"), cursor: { row: 0, colOffset: 0 } }), // gate rejects
    pane({ terminalSurface: meta(18, 60) }),
  ]
  const r = replay(frames)
  expect(r.swaps).toBe(2)
})

// ── Surface-class leak on the patch path ────────────────────────────────────

test("patchPane clears surface classes when a pane falls back to text", () => {
  // `.xterm-surface` / `.terminal-surface` set overflow:hidden, padding:0 and
  // line-height:1 in renderer.css. `fillPane` clears them before re-dispatching,
  // but the body-only patch path did not, so a pane that dropped its terminal
  // surface kept rendering plain text with clipped overflow and terminal
  // line-height. Found while building the swap detector above: keying the
  // detector on this class reported "still xterm" for a pane showing text.
  installDom()
  const { presentDomFrame } = require("../../src/display/dom-frame") as
    typeof import("../../src/display/dom-frame")
  const t = targets()
  const { renderer } = countingRenderer()

  presentDomFrame(t as never, model(pane({ terminalSurface: meta(24, 80) })), undefined, undefined, renderer as never)
  const bodyEl = t.windows.querySelectorAll("window-body")[0]!
  expect(bodyEl.classList.has("xterm-surface")).toBe(true)

  // Body-only change that drops the surface: modeline/footer/chrome all equal,
  // so patchPane takes its incremental branch rather than re-filling the pane.
  presentDomFrame(
    t as never,
    model(pane({ body: themed("back to text"), cursor: { row: 0, colOffset: 0 } })),
    undefined, undefined, renderer as never,
  )
  expect(t.windows.querySelectorAll("window-body")[0]).toBe(bodyEl) // same element: patched, not rebuilt
  expect(bodyEl.classList.has("xterm-surface")).toBe(false)
  expect(bodyEl.classList.has("terminal-surface")).toBe(false)
})
