/// <reference lib="dom" />
import type { SerializedChildFrame, SerializedDisplayModel, SerializedPane, SerializedThemedText, SerializedWindowNode } from "./serialize"
import type { TerminalCell, TerminalSurfaceModel } from "./terminal-surface"

export type SerializedChunk = SerializedThemedText["chunks"][number]

export const DOM_FRAME_ROW_PX = 18
export const DOM_FRAME_COL_PX = 9
/** Matches `body.style.lineHeight` in `renderWindows`. */
export const DOM_FRAME_LINE_HEIGHT_RATIO = 1.35
const DOM_FRAME_BODY_FONT_PX = 13
const DOM_FRAME_MODELINE_FONT_PX = 12

export function effectiveFontSizePx(
  chunk: SerializedChunk,
  textScale: number,
  defaultPx: number,
): number | undefined {
  let px = chunk.height != null ? chunk.height / 10 : defaultPx
  if (chunk.heightScale != null) px *= chunk.heightScale
  if (textScale !== 1) px *= textScale
  return px
}

export function renderChunk(
  parent: HTMLElement,
  chunk: SerializedChunk,
  options: { textScale?: number; defaultFontPx?: number; defaultFamily?: string } = {},
): void {
  const span = document.createElement("span")
  span.textContent = chunk.text
  if (chunk.fg) span.style.color = chunk.fg
  if (chunk.bg) span.style.backgroundColor = chunk.bg
  if (chunk.bold) span.style.fontWeight = "bold"
  if (chunk.italic) span.style.fontStyle = "italic"
  if (chunk.underline) span.style.textDecoration = "underline"
  // Only override when this chunk's family is an actual remap; otherwise let
  // the body{} font-family cascade.
  if (chunk.family && chunk.family !== options.defaultFamily) span.style.fontFamily = chunk.family
  const textScale = options.textScale ?? 1
  const defaultPx = options.defaultFontPx ?? DOM_FRAME_BODY_FONT_PX
  const fontPx = effectiveFontSizePx(chunk, textScale, defaultPx)
  if (fontPx != null && (chunk.height != null || chunk.heightScale != null || textScale !== 1)) {
    span.style.fontSize = `${fontPx}px`
  }
  parent.appendChild(span)
}

export function renderThemedText(
  el: HTMLElement,
  model: SerializedThemedText,
  options: { textScale?: number; defaultFontPx?: number; defaultFamily?: string } = {},
): void {
  el.replaceChildren()
  for (const chunk of model.chunks) renderChunk(el, chunk, options)
}

/** Like `renderThemedText` but splits chunks on `\n` into one `<div.body-row>`
 *  per logical line so the caret can be positioned against a row element. */
export function renderBodyRows(
  el: HTMLElement,
  model: SerializedThemedText,
  options: { textScale?: number; defaultFontPx?: number; defaultFamily?: string } = {},
): HTMLElement[] {
  el.classList.add("web-body")
  const rows: HTMLElement[] = []
  const newRow = () => {
    const r = document.createElement("div")
    r.className = "body-row"
    rows.push(r)
    return r
  }
  let row = newRow()
  for (const chunk of model.chunks) {
    const parts = chunk.text.split("\n")
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) row = newRow()
      if (parts[i]!.length) renderChunk(row, { ...chunk, text: parts[i]! }, options)
    }
  }
  el.replaceChildren(...rows)
  return rows
}

/** rAF handles scheduled by `renderCaret`, cancelled on the next
 *  `presentDomFrame` so the callback never runs against a detached body. */
const pendingCaretRafs = new Set<number>()

function cancelPendingCaretRafs(): void {
  if (typeof cancelAnimationFrame !== "function") { pendingCaretRafs.clear(); return }
  for (const id of pendingCaretRafs) cancelAnimationFrame(id)
  pendingCaretRafs.clear()
}

/** Absolute-position a blinking caret at `cursor.colOffset` chars into
 *  `rows[cursor.row]`. Uses a DOM Range so variable-pitch faces measure
 *  correctly (the whole point of not inserting █ into the text). */
export function renderCaret(
  body: HTMLElement,
  rows: HTMLElement[],
  cursor: { row: number; colOffset: number },
  fg?: string,
  extraClass?: string,
): void {
  const rowEl = rows[Math.min(cursor.row, rows.length - 1)]
  if (!rowEl) return
  const caret = document.createElement("div")
  caret.className = extraClass ? `jemacs-caret ${extraClass}` : "jemacs-caret"
  if (fg) caret.style.backgroundColor = fg
  body.appendChild(caret)
  const place = () => {
    // `body` is reused across renders, so a stale rAF can fire with `body`
    // still connected but this caret already removed (predictive caret swap,
    // or `replaceChildren` in the diff path). The caret is a child of `body`,
    // so guarding on it also covers the body-detached case.
    if (!caret.isConnected) return
    const bodyRect = body.getBoundingClientRect()
    const rowRect = rowEl.getBoundingClientRect()
    let left = rowRect.left
    let height = rowRect.height || DOM_FRAME_ROW_PX
    const range = rangeAtCharOffset(rowEl, cursor.colOffset)
    if (range) {
      const r = range.getBoundingClientRect()
      // Collapsed ranges at column 0 / inside empty rows report a 0×0 rect at
      // (0,0); fall back to the row's left edge in that case.
      if (r.width || r.height || r.left || r.top) {
        left = r.left
        height = r.height || height
      }
    }
    caret.style.left = `${left - bodyRect.left + body.scrollLeft}px`
    caret.style.top = `${rowRect.top - bodyRect.top + body.scrollTop}px`
    caret.style.height = `${height}px`
    // Keep point on screen: M->/M-</C-v reposition the caret outside the
    // visible scroll region; `nearest` is a no-op when already in view.
    if (typeof caret.scrollIntoView === "function") {
      caret.scrollIntoView({ block: "nearest", inline: "nearest" })
    }
  }
  place()
  // Re-measure after layout settles (web fonts, first paint).
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(() => { pendingCaretRafs.delete(id); place() })
    pendingCaretRafs.add(id)
  }
}

function rangeAtCharOffset(row: HTMLElement, colOffset: number): Range | null {
  if (typeof document.createRange !== "function") return null
  let remaining = colOffset
  const walker = document.createTreeWalker(row, 4 /* NodeFilter.SHOW_TEXT */)
  let last: Text | null = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text
    last = text
    const len = text.data.length
    if (remaining <= len) {
      const range = document.createRange()
      range.setStart(text, remaining)
      range.setEnd(text, remaining)
      return range
    }
    remaining -= len
  }
  if (last) {
    const range = document.createRange()
    range.setStart(last, last.data.length)
    range.setEnd(last, last.data.length)
    return range
  }
  return null
}

/** Map a click pixel position to (row, col). When the body has `.body-row`
 *  children we measure their rects and binary-search a Range for the column —
 *  the same machinery `renderCaret` uses, so variable-pitch faces hit-test
 *  correctly. Falls back to the fixed grid for terminal/row-less bodies. */
function hitTestBody(
  body: HTMLElement,
  clientX: number,
  clientY: number,
  rowPx: number,
  colPx: number,
): { row: number; col: number } {
  const rect = body.getBoundingClientRect()
  const rows = body.querySelectorAll<HTMLElement>(".body-row")
  if (rows.length === 0) {
    return {
      row: Math.max(0, Math.floor((clientY - rect.top) / rowPx)),
      col: Math.max(0, Math.floor((clientX - rect.left) / colPx)),
    }
  }
  let row = rows.length - 1
  for (let i = 0; i < rows.length; i++) {
    if (clientY < rows[i]!.getBoundingClientRect().bottom) { row = i; break }
  }
  return { row, col: charOffsetAtX(rows[row]!, clientX, rect.left, colPx) }
}

/** Inverse of `rangeAtCharOffset`: binary-search the character offset whose
 *  collapsed-range left edge is closest to (and ≤) `clientX`. */
function charOffsetAtX(rowEl: HTMLElement, clientX: number, rowLeft: number, colPx: number): number {
  const len = (rowEl.textContent ?? "").length
  if (len === 0 || typeof document.createRange !== "function") {
    return Math.max(0, Math.floor((clientX - rowLeft) / colPx))
  }
  const xAt = (off: number): number => {
    const r = rangeAtCharOffset(rowEl, off)?.getBoundingClientRect()
    return r && (r.width || r.height || r.left || r.top) ? r.left : rowLeft
  }
  let lo = 0, hi = len
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (xAt(mid) <= clientX) lo = mid
    else hi = mid - 1
  }
  return lo
}

export type DomFrameMouseHandler = (windowId: string, row: number, col: number) => void
export type DomTerminalRenderer = {
  mount(body: HTMLElement, pane: SerializedPane, theme?: SerializedDisplayModel["theme"]): boolean
}

type PaneDom = { paneEl: HTMLElement; bodyEl: HTMLElement; modelineEl: HTMLElement }
type PaneSlot = { pane: SerializedPane; dom: PaneDom }

export function renderWindows(
  node: SerializedWindowNode,
  onMouse?: DomFrameMouseHandler,
  terminalRenderer?: DomTerminalRenderer,
  grow = 1,
  theme?: SerializedDisplayModel["theme"],
  slots?: Map<string, PaneSlot>,
): HTMLElement {
  if (node.kind === "leaf") {
    const pane = document.createElement("div")
    const body = document.createElement("div")
    const modeline = document.createElement("div")
    body.className = "window-body"
    modeline.className = "window-modeline"
    pane.append(body, modeline)
    const dom: PaneDom = { paneEl: pane, bodyEl: body, modelineEl: modeline }
    fillPane(dom, node.pane, grow, theme, terminalRenderer)
    body.addEventListener("mousedown", event => {
      if (event.button !== 0 || !onMouse) return
      const textScale = Number(pane.dataset.textScale ?? "1") || 1
      const { row, col } = hitTestBody(body, event.clientX, event.clientY,
        DOM_FRAME_ROW_PX * textScale, DOM_FRAME_COL_PX * textScale)
      onMouse(pane.dataset.windowId!, row, col)
    })
    pane.addEventListener("mousedown", event => {
      if (event.target !== pane || event.button !== 0 || !onMouse) return
      const textScale = Number(pane.dataset.textScale ?? "1") || 1
      const { row, col } = hitTestBody(body, event.clientX, event.clientY,
        DOM_FRAME_ROW_PX * textScale, DOM_FRAME_COL_PX * textScale)
      onMouse(pane.dataset.windowId!, row, col)
    })
    slots?.set(node.pane.id, { pane: node.pane, dom })
    return pane
  }
  const split = document.createElement("div")
  split.className = node.direction === "vertical" ? "split-col" : "split-row"
  split.style.flexGrow = String(Math.max(0.05, grow))
  const firstRatio = node.firstRatio ?? 0.5
  split.append(
    renderWindows(node.first, onMouse, terminalRenderer, firstRatio, theme, slots),
    renderWindows(node.second, onMouse, terminalRenderer, 1 - firstRatio, theme, slots),
  )
  return split
}

/** Populate / repopulate a leaf pane's DOM from its model. Kept separate from
 *  `renderWindows` so the diff path can re-fill an existing pane in place. */
function fillPane(
  dom: PaneDom,
  model: SerializedPane,
  grow: number,
  theme: SerializedDisplayModel["theme"] | undefined,
  terminalRenderer: DomTerminalRenderer | undefined,
): void {
  const { paneEl, bodyEl, modelineEl } = dom
  paneEl.className = `window-pane${model.selected ? " selected" : ""}`
  paneEl.dataset.windowId = model.id
  paneEl.dataset.textScale = String(model.textScale ?? 1)
  paneEl.style.flexGrow = String(Math.max(0.05, grow))
  const defaultFace = themeFace(theme, "default")
  const modelineFace = themeFace(theme, model.selected ? "modeLine" : "modeLineInactive")
  if (defaultFace?.bg) paneEl.style.backgroundColor = defaultFace.bg
  if (modelineFace?.bg) paneEl.style.borderColor = modelineFace.bg
  const textScale = model.textScale ?? 1
  const rowPx = DOM_FRAME_ROW_PX * textScale
  const colPx = DOM_FRAME_COL_PX * textScale
  if (defaultFace?.bg) bodyEl.style.backgroundColor = defaultFace.bg
  const defaultFamily = defaultFace?.family
  const bodyDefaultPx = defaultFace?.height != null ? defaultFace.height / 10 : DOM_FRAME_BODY_FONT_PX
  bodyEl.style.fontSize = `${bodyDefaultPx * textScale}px`
  bodyEl.style.lineHeight = String(DOM_FRAME_LINE_HEIGHT_RATIO)
  if (model.terminalSurface) {
    bodyEl.style.setProperty("--jemacs-terminal-row-px", `${rowPx}px`)
    bodyEl.style.setProperty("--jemacs-terminal-col-px", `${colPx}px`)
    if (!terminalRenderer?.mount(bodyEl, model, theme)) renderTerminalSurface(bodyEl, model.terminalSurface)
  }
  else if (model.cursor) {
    const rows = renderBodyRows(bodyEl, model.body, { textScale, defaultFontPx: bodyDefaultPx, defaultFamily })
    renderCaret(bodyEl, rows, model.cursor, defaultFace?.fg)
  }
  else renderBodyRows(bodyEl, model.body, { textScale, defaultFontPx: bodyDefaultPx, defaultFamily })
  if (modelineFace?.bg) modelineEl.style.backgroundColor = modelineFace.bg
  if (modelineFace?.fg) modelineEl.style.color = modelineFace.fg
  const modelineDefaultPx = modelineFace?.height != null ? modelineFace.height / 10 : DOM_FRAME_MODELINE_FONT_PX
  modelineEl.style.fontSize = `${modelineDefaultPx * textScale}px`
  if (modelineFace?.family && modelineFace.family !== defaultFamily) modelineEl.style.fontFamily = modelineFace.family
  renderThemedText(modelineEl, model.modeline, { textScale, defaultFontPx: modelineDefaultPx, defaultFamily })
}

/** Patch a leaf pane in place, re-rendering only the parts whose serialized
 *  form changed since `prev`. */
function patchPane(
  prev: SerializedPane,
  next: SerializedPane,
  dom: PaneDom,
  grow: number,
  theme: SerializedDisplayModel["theme"] | undefined,
  terminalRenderer: DomTerminalRenderer | undefined,
): void {
  const chromeChanged = prev.selected !== next.selected || prev.textScale !== next.textScale
  const bodyChanged = !sameJson(prev.body, next.body)
    || !sameJson(prev.cursor, next.cursor)
    || !sameJson(prev.terminalSurface, next.terminalSurface)
  const modelineChanged = !sameJson(prev.modeline, next.modeline)
  // Terminal fast path: same-shape grid → mutate cells in place.
  if (!chromeChanged && !modelineChanged
    && prev.terminalSurface && next.terminalSurface
    && prev.terminalSurface.rows === next.terminalSurface.rows
    && prev.terminalSurface.cols === next.terminalSurface.cols
    && dom.bodyEl.querySelectorAll(".terminal-row").length === next.terminalSurface.rows) {
    patchTerminalSurface(dom.bodyEl, prev.terminalSurface, next.terminalSurface)
    return
  }
  if (!chromeChanged && !bodyChanged && !modelineChanged) return
  if (chromeChanged || (bodyChanged && modelineChanged)) {
    fillPane(dom, next, grow, theme, terminalRenderer)
    return
  }
  const defaultFace = themeFace(theme, "default")
  const defaultFamily = defaultFace?.family
  const textScale = next.textScale ?? 1
  if (bodyChanged) {
    const bodyDefaultPx = defaultFace?.height != null ? defaultFace.height / 10 : DOM_FRAME_BODY_FONT_PX
    if (next.terminalSurface) {
      if (!terminalRenderer?.mount(dom.bodyEl, next, theme)) renderTerminalSurface(dom.bodyEl, next.terminalSurface)
    }
    else if (next.cursor) {
      const rows = renderBodyRows(dom.bodyEl, next.body, { textScale, defaultFontPx: bodyDefaultPx, defaultFamily })
      renderCaret(dom.bodyEl, rows, next.cursor, defaultFace?.fg)
    }
    else renderBodyRows(dom.bodyEl, next.body, { textScale, defaultFontPx: bodyDefaultPx, defaultFamily })
  }
  if (modelineChanged) {
    const modelineFace = themeFace(theme, next.selected ? "modeLine" : "modeLineInactive")
    const modelineDefaultPx = modelineFace?.height != null ? modelineFace.height / 10 : DOM_FRAME_MODELINE_FONT_PX
    renderThemedText(dom.modelineEl, next.modeline, { textScale, defaultFontPx: modelineDefaultPx, defaultFamily })
  }
}

function patchTerminalSurface(body: HTMLElement, prev: TerminalSurfaceModel, next: TerminalSurfaceModel): void {
  const rowEls = body.querySelectorAll<HTMLElement>(".terminal-row")
  for (let y = 0; y < next.rows; y++) {
    const rowEl = rowEls[y]!
    const prevRow = prev.cells[y] ?? []
    const nextRow = next.cells[y] ?? []
    for (let x = 0; x < next.cols; x++) {
      const span = rowEl.children[x] as HTMLElement | undefined
      if (!span) continue
      const a = prevRow[x] ?? { text: " " }
      const b = nextRow[x] ?? { text: " " }
      const wasCursor = y === prev.cursorRow && x === prev.cursorCol
      const isCursor = y === next.cursorRow && x === next.cursorCol
      if (sameCell(a, b) && wasCursor === isCursor) continue
      span.textContent = b.text || " "
      span.style.color = b.fg ?? ""
      span.style.backgroundColor = b.bg ?? ""
      span.style.fontWeight = b.bold ? "bold" : ""
      span.style.fontStyle = b.italic ? "italic" : ""
      span.style.textDecoration = b.underline ? "underline" : ""
      if (wasCursor !== isCursor) {
        if (isCursor) span.classList.add("terminal-cursor")
        else span.classList.remove("terminal-cursor")
      }
    }
  }
}

function sameCell(a: TerminalCell, b: TerminalCell): boolean {
  return a.text === b.text && a.fg === b.fg && a.bg === b.bg
    && a.bold === b.bold && a.italic === b.italic && a.underline === b.underline
}

function renderChildFrame(frame: SerializedChildFrame, theme?: SerializedDisplayModel["theme"]): HTMLElement {
  const el = document.createElement("div")
  el.className = "jemacs-child-frame"
  el.dataset.childFrameId = frame.id
  el.style.top = `${frame.top * DOM_FRAME_ROW_PX}px`
  el.style.left = `${frame.left * DOM_FRAME_COL_PX}px`
  el.style.width = `${frame.width * DOM_FRAME_COL_PX}px`
  el.style.maxHeight = `${frame.height * DOM_FRAME_ROW_PX}px`
  const defaultFace = themeFace(theme, "default")
  const modelineFace = themeFace(theme, "modeLine")
  if (defaultFace?.bg) el.style.backgroundColor = defaultFace.bg
  if (defaultFace?.fg) el.style.color = defaultFace.fg
  if (modelineFace?.bg) el.style.borderColor = modelineFace.bg
  const body = document.createElement("div")
  body.className = "jemacs-child-frame-body"
  renderThemedText(body, frame.pane.body, {
    textScale: frame.pane.textScale,
    defaultFontPx: defaultFace?.height != null ? defaultFace.height / 10 : DOM_FRAME_BODY_FONT_PX,
    defaultFamily: defaultFace?.family,
  })
  el.appendChild(body)
  return el
}

function renderTerminalSurface(el: HTMLElement, surface: TerminalSurfaceModel): void {
  el.replaceChildren()
  el.classList.add("terminal-surface")
  for (let y = 0; y < surface.rows; y++) {
    const rowEl = document.createElement("div")
    rowEl.className = "terminal-row"
    const row = surface.cells[y] ?? []
    for (let x = 0; x < surface.cols; x++) {
      const cell = row[x] ?? { text: " " }
      const span = document.createElement("span")
      span.textContent = cell.text || " "
      applyTerminalCell(span, cell)
      if (y === surface.cursorRow && x === surface.cursorCol) span.classList.add("terminal-cursor")
      rowEl.appendChild(span)
    }
    el.appendChild(rowEl)
  }
}

function applyTerminalCell(el: HTMLElement, cell: TerminalCell): void {
  if (cell.fg) el.style.color = cell.fg
  if (cell.bg) el.style.backgroundColor = cell.bg
  if (cell.bold) el.style.fontWeight = "bold"
  if (cell.italic) el.style.fontStyle = "italic"
  if (cell.underline) el.style.textDecoration = "underline"
}

export type DomFrameTargets = {
  title: HTMLElement
  windows: HTMLElement
  minibufferCompletions?: HTMLElement
  minibuffer: HTMLElement
  echo: HTMLElement
}

type FrameMemo = {
  model: SerializedDisplayModel
  shape: string
  panes: Map<string, PaneSlot>
  childFramesEl: HTMLElement[]
}
const frameMemo = new WeakMap<HTMLElement, FrameMemo>()

function treeShape(node: SerializedWindowNode): string {
  return node.kind === "leaf"
    ? `L${node.pane.id}`
    : `S${node.direction[0]}${node.firstRatio ?? 0.5}(${treeShape(node.first)},${treeShape(node.second)})`
}

function forEachLeaf(
  node: SerializedWindowNode,
  fn: (pane: SerializedPane, grow: number) => void,
  grow = 1,
): void {
  if (node.kind === "leaf") return fn(node.pane, grow)
  const r = node.firstRatio ?? 0.5
  forEachLeaf(node.first, fn, r)
  forEachLeaf(node.second, fn, 1 - r)
}

const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

export function presentDomFrame(
  targets: DomFrameTargets,
  model: SerializedDisplayModel,
  onMouse?: DomFrameMouseHandler,
  terminalRenderer?: DomTerminalRenderer,
): void {
  cancelPendingCaretRafs()
  const prev = frameMemo.get(targets.windows)
  applyThemeSurfaces(targets, model)
  const defaultFace = model.theme.faces.default
  const defaultPx = defaultFace?.height != null ? defaultFace.height / 10 : DOM_FRAME_BODY_FONT_PX
  const defaultFamily = defaultFace?.family
  if (!prev || !sameJson(prev.model.title, model.title)) {
    renderThemedText(targets.title, model.title, { defaultFontPx: defaultPx, defaultFamily })
  }

  const shape = treeShape(model.windows)
  let panes: Map<string, PaneSlot>
  let childFramesEl: HTMLElement[]
  if (prev && prev.shape === shape && sameJson(prev.model.theme, model.theme)) {
    panes = prev.panes
    forEachLeaf(model.windows, (next, grow) => {
      const slot = panes.get(next.id)!
      patchPane(slot.pane, next, slot.dom, grow, model.theme, terminalRenderer)
      slot.pane = next
    })
    if (sameJson(prev.model.childFrames, model.childFrames)) {
      childFramesEl = prev.childFramesEl
    }
    else {
      for (const el of prev.childFramesEl) el.remove()
      childFramesEl = (model.childFrames ?? []).map(f => renderChildFrame(f, model.theme))
      for (const el of childFramesEl) targets.windows.appendChild(el)
    }
  }
  else {
    panes = new Map()
    childFramesEl = (model.childFrames ?? []).map(f => renderChildFrame(f, model.theme))
    targets.windows.replaceChildren(
      renderWindows(model.windows, onMouse, terminalRenderer, 1, model.theme, panes),
      ...childFramesEl,
    )
  }

  if (targets.minibufferCompletions) {
    if (!prev || !sameJson(prev.model.minibufferCompletions, model.minibufferCompletions)) {
      renderThemedText(targets.minibufferCompletions, model.minibufferCompletions, { defaultFontPx: defaultPx, defaultFamily })
    }
    targets.minibufferCompletions.style.display = model.minibufferCompletionLines > 0 ? "" : "none"
  }
  if (!prev || !sameJson(prev.model.minibuffer, model.minibuffer)) {
    renderThemedText(targets.minibuffer, model.minibuffer, { defaultFontPx: defaultPx, defaultFamily })
  }
  if (!prev || !sameJson(prev.model.echo, model.echo)) {
    renderThemedText(targets.echo, model.echo, { defaultFontPx: defaultPx, defaultFamily })
  }
  frameMemo.set(targets.windows, { model, shape, panes, childFramesEl })
}

function applyThemeSurfaces(targets: DomFrameTargets, model: SerializedDisplayModel): void {
  const defaultFace = model.theme.faces.default
  const defaultFamily = defaultFace?.family
  const titleFace = model.theme.faces.title ?? defaultFace
  const minibufferFace = model.theme.faces.minibuffer ?? defaultFace
  const bg = defaultFace?.bg
  const fg = defaultFace?.fg
  const root = document.getElementById("jemacs-root")
  for (const el of [document.documentElement, document.body, root, targets.windows]) {
    if (!el) continue
    if (bg) el.style.backgroundColor = bg
    if (fg) el.style.color = fg
  }
  // Default family is applied once at the cascade root; descendants inherit.
  if (defaultFamily) document.body.style.fontFamily = defaultFamily
  applyFace(targets.title, titleFace, defaultFamily)
  if (targets.minibufferCompletions) applyFace(targets.minibufferCompletions, minibufferFace, defaultFamily)
  applyFace(targets.minibuffer, minibufferFace, defaultFamily)
  applyFace(targets.echo, minibufferFace, defaultFamily)
}

function applyFace(
  el: HTMLElement,
  face: { fg?: string; bg?: string; family?: string; height?: number } | undefined,
  defaultFamily?: string,
): void {
  if (face?.bg) el.style.backgroundColor = face.bg
  if (face?.fg) el.style.color = face.fg
  if (face?.family && face.family !== defaultFamily) el.style.fontFamily = face.family
  if (face?.height != null) el.style.fontSize = `${face.height / 10}px`
}

function themeFace(
  theme: SerializedDisplayModel["theme"] | undefined,
  face: string,
): { fg?: string; bg?: string; family?: string; height?: number } | undefined {
  if (!theme) return undefined
  return (theme.faces as Record<string, { fg?: string; bg?: string; family?: string; height?: number } | undefined>)[face]
    ?? theme.faces.default
}
