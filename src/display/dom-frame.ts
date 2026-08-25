/// <reference lib="dom" />
import type { SerializedChildFrame, SerializedDisplayModel, SerializedPane, SerializedThemedText, SerializedWindowNode } from "./serialize"
import type { TerminalCell, TerminalSurfaceModel } from "./terminal-surface"
import type { CanvasSurfaceModel, WebNodeModel } from "../kernel/extension-points"

export type SerializedChunk = SerializedThemedText["chunks"][number]

export const DOM_FRAME_ROW_PX = 18
export const DOM_FRAME_COL_PX = 9
/** Matches `body.style.lineHeight` in `renderWindows`. */
export const DOM_FRAME_LINE_HEIGHT_RATIO = 1.35
export const DOM_FRAME_BODY_FONT_PX = 13
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

/**
 * Identity of a row's rendered content, used to decide whether it can be left alone.
 *
 * Cheaper than comparing DOM, and covers everything `renderChunk` reads: the text plus
 * every style-bearing field. Two rows with equal signatures produce identical markup.
 */
function rowSignature(
  parts: Array<{ chunk: SerializedChunk; text: string }>,
  options: { textScale?: number; defaultFontPx?: number; defaultFamily?: string },
): string {
  const scale = options.textScale ?? 1
  const defaultPx = options.defaultFontPx ?? DOM_FRAME_BODY_FONT_PX
  const family = options.defaultFamily ?? ""
  let out = `${scale}|${defaultPx}|${family}`
  for (const { chunk, text } of parts) {
    out += `\u0000${text}\u0001${chunk.fg ?? ""}\u0001${chunk.bg ?? ""}`
      + `\u0001${chunk.bold ? 1 : 0}${chunk.italic ? 1 : 0}${chunk.underline ? 1 : 0}`
      + `\u0001${chunk.family ?? ""}\u0001${chunk.height ?? ""}\u0001${chunk.heightScale ?? ""}`
  }
  return out
}

/**
 * Signature of the content each row element currently displays.
 *
 * Held off to the side rather than in `dataset`, because hosts and tests supply their own
 * element implementations and not all of them provide it. A WeakMap also keeps the marker
 * out of the rendered HTML and lets the entry die with the element.
 */
const rowSignatures = new WeakMap<object, string>()

/** Like `renderThemedText` but splits chunks on `\n` into one `<div.body-row>`
 *  per logical line so the caret can be positioned against a row element.
 *
 *  Reconciles against the rows already in `el` instead of replacing them. Rebuilding the
 *  whole subtree every frame made the browser discard and re-lay-out every line on each
 *  cursor move, which is visible as flicker -- worst in markdown, where a variable-pitch
 *  default and height-scaled headings make each rebuild a full font reflow. */
export function renderBodyRows(
  el: HTMLElement,
  model: SerializedThemedText,
  options: { textScale?: number; defaultFontPx?: number; defaultFamily?: string } = {},
): HTMLElement[] {
  el.classList.add("web-body")

  // Split the chunk stream into per-line pieces first, so a row can be compared
  // before any DOM is touched.
  const lines: Array<Array<{ chunk: SerializedChunk; text: string }>> = [[]]
  for (const chunk of model.chunks) {
    const parts = chunk.text.split("\n")
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([])
      if (parts[i]!.length) lines[lines.length - 1]!.push({ chunk, text: parts[i]! })
    }
  }

  // Duck-typed rather than `instanceof HTMLElement`: hosts and tests supply their own
  // element implementations, and some run where that global does not exist at all.
  const isBodyRow = (child: unknown): child is HTMLElement =>
    !!child
    && typeof (child as HTMLElement).classList?.contains === "function"
    && (child as HTMLElement).classList.contains("body-row")

  const existing: HTMLElement[] = []
  for (const child of Array.from(el.children)) {
    if (isBodyRow(child)) existing.push(child)
  }

  const rows: HTMLElement[] = []
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i]!
    const signature = rowSignature(parts, options)
    const reusable = existing[i]
    if (reusable && rowSignatures.get(reusable) === signature) {
      rows.push(reusable)
      continue
    }
    const row = reusable ?? document.createElement("div")
    if (!reusable) row.className = "body-row"
    // Same element, new content: swap the spans rather than the row itself, so the
    // browser repaints one line instead of the whole body.
    row.replaceChildren()
    for (const { chunk, text } of parts) renderChunk(row, { ...chunk, text }, options)
    rowSignatures.set(row, signature)
    rows.push(row)
  }

  // Rows are reconciled by index, so the reused ones are already in order and only the
  // tail can be new. Drop everything that is not a surviving row -- surplus rows from a
  // shorter render, and any non-row child (a caret from a previous frame) that the old
  // `replaceChildren` used to clear implicitly -- then append the new tail.
  //
  // Deliberately `remove()` + `appendChild` rather than `insertBefore`: those two are the
  // only mutators every host stub in this codebase implements, and by construction no
  // reordering is required here.
  const keep = new Set(rows)
  for (const child of Array.from(el.children)) {
    if (!keep.has(child as HTMLElement)) child.remove()
  }
  for (const row of rows) {
    if (row.parentNode !== el) el.appendChild(row)
  }
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

/** Caret height as a multiple of the font size under point. Chosen to sit just
 *  above the em box so the bar covers the glyph without touching the line above. */
export const CARET_HEIGHT_RATIO = 1.2
/** Caret width as a multiple of the font size under point, so a caret inside a
 *  2x heading is twice as thick as one in body text instead of a hairline. */
const CARET_WIDTH_RATIO = 1 / 8
const CARET_MIN_WIDTH_PX = 1.5
/** Fallback box width (as a multiple of the font size) when the character under
 *  point cannot be measured -- end of line, empty row, no Range support. */
const BLOCK_FALLBACK_WIDTH_RATIO = 0.6

export type CaretShape = "bar" | "box"

const isHighSurrogateCode = (c: number) => c >= 0xd800 && c <= 0xdbff

/** Client rect of the single character at `colOffset`, used to size a box
 *  cursor to the glyph it covers (a variable-pitch `i` and `W` differ). */
function charRectAtOffset(row: HTMLElement, colOffset: number): DOMRect | null {
  if (typeof document.createRange !== "function") return null
  let remaining = colOffset
  const walker = document.createTreeWalker(row, 4 /* NodeFilter.SHOW_TEXT */)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text
    const len = text.data.length
    if (remaining < len) {
      const span = isHighSurrogateCode(text.data.charCodeAt(remaining)) ? 2 : 1
      const range = document.createRange()
      range.setStart(text, remaining)
      range.setEnd(text, Math.min(len, remaining + span))
      const rect = range.getBoundingClientRect()
      return rect.width ? rect : null
    }
    remaining -= len
  }
  return null
}

/** Font size in effect at a caret position, in px.
 *
 *  Read from the *span* under point rather than the row: a markdown row mixes
 *  faces (a 28px heading, 14px body, monospace code), and the row box is as
 *  tall as its tallest child. Sizing the caret off the row is what made it
 *  visibly change height from line to line and tower over inline code. */
function fontPxAtCaret(rowEl: HTMLElement, colOffset: number, fallbackPx: number): number {
  const host = elementAtCharOffset(rowEl, colOffset) ?? rowEl
  if (typeof getComputedStyle !== "function") return fallbackPx
  const px = Number.parseFloat(getComputedStyle(host).fontSize)
  return Number.isFinite(px) && px > 0 ? px : fallbackPx
}

/** The element whose font applies at `colOffset` (the span containing that
 *  character, or the one just before it at a row/segment end). */
function elementAtCharOffset(rowEl: HTMLElement, colOffset: number): HTMLElement | null {
  const children = Array.from(rowEl.children) as HTMLElement[]
  if (!children.length) return null
  let remaining = colOffset
  for (const child of children) {
    const len = (child.textContent ?? "").length
    if (remaining < len) return child
    remaining -= len
  }
  return children[children.length - 1] ?? null
}

/** Absolute-position a blinking caret at `cursor.colOffset` chars into
 *  `rows[cursor.row]`. Uses a DOM Range so variable-pitch faces measure
 *  correctly (the whole point of not inserting █ into the text). */
export function renderCaret(
  body: HTMLElement,
  rows: HTMLElement[],
  cursor: { row: number; colOffset: number; shape?: CaretShape },
  fg?: string,
  extraClass?: string,
): void {
  const rowEl = rows[Math.min(cursor.row, rows.length - 1)]
  if (!rowEl) return
  const block = cursor.shape === "box"
  const caret = document.createElement("div")
  const classes = ["jemacs-caret"]
  if (block) classes.push("block")
  if (extraClass) classes.push(extraClass)
  caret.className = classes.join(" ")
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
    // The line box the caret sits on. A row can be taller than this when it
    // holds a mix of faces, so keep them separate: the caret is centred on its
    // own line box, not on the row.
    let lineTop = rowRect.top
    let lineHeight = rowRect.height || DOM_FRAME_ROW_PX
    const range = rangeAtCharOffset(rowEl, cursor.colOffset)
    if (range) {
      const r = range.getBoundingClientRect()
      // Collapsed ranges at column 0 / inside empty rows report a 0×0 rect at
      // (0,0); fall back to the row's left edge in that case.
      if (r.width || r.height || r.left || r.top) {
        left = r.left
        if (r.height) {
          lineTop = r.top
          lineHeight = r.height
        }
      }
    }
    // Size from the font under point, not from the line box: line boxes carry
    // leading (and a row's leading is set by its tallest face), so measuring
    // them made the caret a different height on nearly every markdown line.
    const fontPx = fontPxAtCaret(rowEl, cursor.colOffset, lineHeight / DOM_FRAME_LINE_HEIGHT_RATIO)
    const height = Math.round(fontPx * CARET_HEIGHT_RATIO)
    // A box cursor is as wide as the glyph it sits on; a bar is a fixed sliver.
    const width = block
      ? Math.max(CARET_MIN_WIDTH_PX, Math.round(
        charRectAtOffset(rowEl, cursor.colOffset)?.width ?? fontPx * BLOCK_FALLBACK_WIDTH_RATIO))
      : Math.max(CARET_MIN_WIDTH_PX, Math.round(fontPx * CARET_WIDTH_RATIO))
    const caretTop = lineTop - bodyRect.top + body.scrollTop
      + Math.max(0, (lineHeight - height) / 2)
    caret.style.left = `${left - bodyRect.left + body.scrollLeft}px`
    caret.style.top = `${caretTop}px`
    caret.style.height = `${height}px`
    caret.style.width = `${width}px`
    // Keep point on screen: M->/M-</C-v reposition the caret outside the visible
    // scroll region.
    //
    // Deliberately not `scrollIntoView`. The caret is absolutely positioned inside the
    // scroll container, so it contributes to `scrollHeight`; on the last row it extends
    // the scrollable area past the content, and `nearest` then scrolls to reveal that
    // overhang. That shifts the rows, which repositions the caret on the next frame --
    // a loop the user sees as flicker at the bottom of a buffer. Scrolling only when
    // the caret is genuinely outside the viewport, by the exact deficit, is stable:
    // once corrected the condition is false, so it cannot oscillate.
    const viewTop = body.scrollTop
    const viewBottom = viewTop + body.clientHeight
    if (body.clientHeight > 0) {
      if (caretTop < viewTop) body.scrollTop = caretTop
      else if (caretTop + height > viewBottom) body.scrollTop = caretTop + height - body.clientHeight
    }
  }
  place()
  // Re-measure after layout settles (web fonts, first paint).
  //
  // `handle` is assigned before the callback can read it: hosts and test doubles
  // are allowed to invoke the callback synchronously, and a `const id = raf(...)`
  // that the callback closes over is in its temporal dead zone for exactly that
  // case.
  if (typeof requestAnimationFrame === "function") {
    let handle: number | undefined
    let ran = false
    handle = requestAnimationFrame(() => {
      ran = true
      if (handle !== undefined) pendingCaretRafs.delete(handle)
      place()
    })
    if (!ran) pendingCaretRafs.add(handle)
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

/** `drag` is true for the move events of a press-drag gesture, so the kernel
 *  extends the region instead of re-placing point. */
export type DomFrameMouseHandler = (windowId: string, row: number, col: number, drag?: boolean) => void

/** Turn a mousedown into a click plus (while the button is held) a stream of
 *  deduped drag positions, so selecting with the cursor marks the region. */
function beginMouseDrag(
  event: MouseEvent,
  paneEl: HTMLElement,
  bodyEl: HTMLElement,
  onMouse: DomFrameMouseHandler,
): void {
  let lastRow = -1
  let lastCol = -1
  const send = (ev: MouseEvent, drag: boolean) => {
    const textScale = Number(paneEl.dataset.textScale ?? "1") || 1
    const { row, col } = hitTestBody(bodyEl, ev.clientX, ev.clientY,
      DOM_FRAME_ROW_PX * textScale, DOM_FRAME_COL_PX * textScale)
    if (drag && row === lastRow && col === lastCol) return
    lastRow = row
    lastCol = col
    onMouse(paneEl.dataset.windowId!, row, col, drag)
  }
  send(event, false)
  // The fake DOM used by the display tests has no document-level listeners;
  // the plain click above is all those paths need.
  const doc = typeof document !== "undefined" && typeof document.addEventListener === "function" ? document : null
  if (!doc) return
  // Suppress the native blue selection so only the region face is visible.
  event.preventDefault?.()
  const onMove = (ev: Event) => send(ev as MouseEvent, true)
  const onUp = () => {
    doc.removeEventListener("mousemove", onMove)
    doc.removeEventListener("mouseup", onUp)
  }
  doc.addEventListener("mousemove", onMove)
  doc.addEventListener("mouseup", onUp)
}
/** Click on the tab bar, reported as a character column into its text. */
export type DomFrameTabBarHandler = (col: number) => void

export type DomFramePaneActionHandler = (
  windowId: string,
  action: string,
  payload?: Record<string, string | number | boolean>,
) => void
export type DomTerminalRenderer = {
  mount(body: HTMLElement, pane: SerializedPane, theme?: SerializedDisplayModel["theme"]): boolean
}

type PaneDom = { paneEl: HTMLElement; bodyEl: HTMLElement; footerEl: HTMLElement; modelineEl: HTMLElement }
type PaneSlot = { pane: SerializedPane; dom: PaneDom }

export function renderWindows(
  node: SerializedWindowNode,
  onMouse?: DomFrameMouseHandler,
  onPaneAction?: DomFramePaneActionHandler,
  terminalRenderer?: DomTerminalRenderer,
  grow = 1,
  theme?: SerializedDisplayModel["theme"],
  slots?: Map<string, PaneSlot>,
): HTMLElement {
  if (node.kind === "leaf") {
    const pane = document.createElement("div")
    const body = document.createElement("div")
    const footer = document.createElement("div")
    const modeline = document.createElement("div")
    body.className = "window-body"
    footer.className = "window-footer"
    modeline.className = "window-modeline"
    pane.append(body, footer, modeline)
    const dom: PaneDom = { paneEl: pane, bodyEl: body, footerEl: footer, modelineEl: modeline }
    fillPane(dom, node.pane, grow, theme, terminalRenderer, onPaneAction)
    body.addEventListener("mousedown", event => {
      if (event.button !== 0 || !onMouse) return
      beginMouseDrag(event, pane, body, onMouse)
    })
    pane.addEventListener("mousedown", event => {
      if (event.target !== pane || event.button !== 0 || !onMouse) return
      beginMouseDrag(event, pane, body, onMouse)
    })
    slots?.set(node.pane.id, { pane: node.pane, dom })
    return pane
  }
  const split = document.createElement("div")
  split.className = node.direction === "vertical" ? "split-col" : "split-row"
  split.style.flexGrow = String(Math.max(0.05, grow))
  const firstRatio = node.firstRatio ?? 0.5
  split.append(
    renderWindows(node.first, onMouse, onPaneAction, terminalRenderer, firstRatio, theme, slots),
    renderWindows(node.second, onMouse, onPaneAction, terminalRenderer, 1 - firstRatio, theme, slots),
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
  onPaneAction?: DomFramePaneActionHandler,
): void {
  const { paneEl, bodyEl, footerEl, modelineEl } = dom
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
  removeClasses(bodyEl, "terminal-surface", "xterm-surface", "rich-table-surface", "web-surface", "web-body")
  if (model.terminalSurface) {
    bodyEl.style.setProperty("--jemacs-terminal-row-px", `${rowPx}px`)
    bodyEl.style.setProperty("--jemacs-terminal-col-px", `${colPx}px`)
    if (!terminalRenderer?.mount(bodyEl, model, theme)) renderTerminalSurface(bodyEl, model.terminalSurface)
  }
  else if (model.tableSurface) {
    renderTableSurface(bodyEl, model, theme, onPaneAction)
  }
  else if (model.webSurface) {
    renderWebSurface(bodyEl, model, theme, onPaneAction)
  }
  else if (model.cursor) {
    const rows = renderBodyRows(bodyEl, model.body, { textScale, defaultFontPx: bodyDefaultPx, defaultFamily })
    renderCaret(bodyEl, rows, model.cursor, defaultFace?.fg)
  }
  else renderBodyRows(bodyEl, model.body, { textScale, defaultFontPx: bodyDefaultPx, defaultFamily })
  if (modelineFace?.bg) modelineEl.style.backgroundColor = modelineFace.bg
  if (modelineFace?.fg) modelineEl.style.color = modelineFace.fg
  const modelineDefaultPx = modelineFace?.height != null ? modelineFace.height / 10 : DOM_FRAME_MODELINE_FONT_PX
  footerEl.style.display = model.footer ? "" : "none"
  footerEl.style.fontSize = `${modelineDefaultPx * textScale}px`
  if (modelineFace?.family && modelineFace.family !== defaultFamily) footerEl.style.fontFamily = modelineFace.family
  renderThemedText(footerEl, model.footer ?? { chunks: [] }, { textScale, defaultFontPx: modelineDefaultPx, defaultFamily })
  modelineEl.style.fontSize = `${modelineDefaultPx * textScale}px`
  if (modelineFace?.family && modelineFace.family !== defaultFamily) modelineEl.style.fontFamily = modelineFace.family
  renderThemedText(modelineEl, model.modeline, { textScale, defaultFontPx: modelineDefaultPx, defaultFamily })
}

function removeClasses(el: HTMLElement, ...classes: string[]): void {
  const classList = el.classList as DOMTokenList | Set<string>
  if ("remove" in classList) classList.remove(...classes)
  else for (const cls of classes) classList.delete(cls)
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
  onPaneAction?: DomFramePaneActionHandler,
): void {
  const chromeChanged = prev.selected !== next.selected || prev.textScale !== next.textScale
  const bodyChanged = !sameJson(prev.body, next.body)
    || !sameJson(prev.cursor, next.cursor)
    || !sameJson(prev.terminalSurface, next.terminalSurface)
    || !sameJson(prev.tableSurface, next.tableSurface)
    || !sameJson(prev.webSurface, next.webSurface)
  const footerChanged = !sameJson(prev.footer, next.footer)
  const modelineChanged = !sameJson(prev.modeline, next.modeline)
  // Terminal fast path: same-shape grid → mutate cells in place.
  if (!chromeChanged && !footerChanged && !modelineChanged
    && prev.terminalSurface && next.terminalSurface
    && prev.terminalSurface.rows === next.terminalSurface.rows
    && prev.terminalSurface.cols === next.terminalSurface.cols
    && dom.bodyEl.querySelectorAll(".terminal-row").length === next.terminalSurface.rows) {
    patchTerminalSurface(dom.bodyEl, prev.terminalSurface, next.terminalSurface)
    return
  }
  if (!chromeChanged && !bodyChanged && !footerChanged && !modelineChanged) return
  if (chromeChanged || (bodyChanged && (footerChanged || modelineChanged))) {
    fillPane(dom, next, grow, theme, terminalRenderer, onPaneAction)
    return
  }
  const defaultFace = themeFace(theme, "default")
  const defaultFamily = defaultFace?.family
  const textScale = next.textScale ?? 1
  if (bodyChanged) {
    const bodyDefaultPx = defaultFace?.height != null ? defaultFace.height / 10 : DOM_FRAME_BODY_FONT_PX
    // Surface classes carry terminal-specific geometry (overflow:hidden,
    // padding:0, line-height:1). `fillPane` clears them before re-dispatching;
    // this path must too, or a pane that falls back from a terminal surface to
    // text keeps rendering that text with clipped overflow and terminal
    // line-height.
    if (!next.terminalSurface) removeClasses(dom.bodyEl, "terminal-surface", "xterm-surface")
    if (!next.tableSurface) removeClasses(dom.bodyEl, "rich-table-surface")
    if (!next.webSurface) removeClasses(dom.bodyEl, "web-surface")
    if (next.terminalSurface) {
      if (!terminalRenderer?.mount(dom.bodyEl, next, theme)) renderTerminalSurface(dom.bodyEl, next.terminalSurface)
    }
    else if (next.tableSurface) renderTableSurface(dom.bodyEl, next, theme, onPaneAction)
    else if (next.webSurface) renderWebSurface(dom.bodyEl, next, theme, onPaneAction)
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
  if (footerChanged) {
    const modelineFace = themeFace(theme, next.selected ? "modeLine" : "modeLineInactive")
    const modelineDefaultPx = modelineFace?.height != null ? modelineFace.height / 10 : DOM_FRAME_MODELINE_FONT_PX
    dom.footerEl.style.display = next.footer ? "" : "none"
    renderThemedText(dom.footerEl, next.footer ?? { chunks: [] }, { textScale, defaultFontPx: modelineDefaultPx, defaultFamily })
  }
}

function renderTableSurface(
  el: HTMLElement,
  pane: SerializedPane,
  theme: SerializedDisplayModel["theme"] | undefined,
  onPaneAction?: DomFramePaneActionHandler,
): void {
  const surface = pane.tableSurface
  if (!surface) return
  el.replaceChildren()
  el.classList.add("rich-table-surface")
  const table = document.createElement("table")
  table.className = "rich-table"

  const colgroup = document.createElement("colgroup")
  for (const column of surface.columns) {
    const col = document.createElement("col")
    if (column.width) col.style.width = `${column.width}ch`
    if (column.minWidth) col.style.minWidth = `${column.minWidth}ch`
    if (column.maxWidth) col.style.maxWidth = `${column.maxWidth}ch`
    colgroup.appendChild(col)
  }
  table.appendChild(colgroup)

  const hasActions = surface.rows.some(row => row.actions?.length)
  const thead = document.createElement("thead")
  const headerRow = document.createElement("tr")
  for (const column of surface.columns) {
    const th = document.createElement("th")
    th.className = `align-${column.align ?? "left"}`
    th.textContent = column.label + (column.sortDirection ? column.sortDirection === "desc" ? " ▼" : " ▲" : "")
    if (column.sortable) {
      th.classList.add("sortable")
      th.addEventListener("click", event => {
        event.stopPropagation()
        onPaneAction?.(pane.id, "sort", { key: column.key })
      })
    }
    headerRow.appendChild(th)
  }
  if (hasActions) {
    const th = document.createElement("th")
    th.className = "rich-table-actions"
    headerRow.appendChild(th)
  }
  thead.appendChild(headerRow)
  table.appendChild(thead)

  const tbody = document.createElement("tbody")
  if (!surface.rows.length) {
    const tr = document.createElement("tr")
    const td = document.createElement("td")
    td.className = "rich-table-empty"
    td.colSpan = surface.columns.length + (hasActions ? 1 : 0)
    td.textContent = surface.emptyText ?? ""
    tr.appendChild(td)
    tbody.appendChild(tr)
  }
  for (const row of surface.rows) {
    const tr = document.createElement("tr")
    tr.dataset.rowId = row.id
    tr.dataset.line = String(row.line)
    if (row.selected) tr.classList.add("selected-row")
    if (row.marked) tr.classList.add("marked-row")
    tr.addEventListener("click", event => {
      if (event.target instanceof HTMLElement && event.target.closest("button")) return
      event.stopPropagation()
      onPaneAction?.(pane.id, "select-row", { line: row.line })
    })
    surface.columns.forEach((column, index) => {
      const td = document.createElement("td")
      td.className = `align-${column.align ?? "left"}`
      const cell = row.cells[column.key] ?? { text: "" }
      if (cell.title) td.title = cell.title
      if (cell.face) {
        td.dataset.face = cell.face
        applyTableCellFace(td, cell.face, theme)
      }
      if (index === 0 && row.depth) td.style.paddingLeft = `${8 + row.depth * 14}px`
      if (typeof cell.bar === "number") {
        const bar = document.createElement("span")
        bar.className = "rich-table-bar"
        const fill = document.createElement("span")
        fill.className = "rich-table-bar-fill"
        fill.style.width = `${Math.max(0, Math.min(100, cell.bar))}%`
        const label = document.createElement("span")
        label.className = "rich-table-bar-label"
        label.textContent = cell.text
        bar.append(fill, label)
        td.appendChild(bar)
      } else if (cell.badge) {
        const badge = document.createElement("span")
        badge.className = `rich-table-badge ${cell.badge}`
        badge.textContent = cell.text
        td.appendChild(badge)
      } else {
        td.textContent = cell.text
      }
      tr.appendChild(td)
    })
    if (hasActions) {
      const td = document.createElement("td")
      td.className = "rich-table-actions"
      for (const action of row.actions ?? []) {
        const button = document.createElement("button")
        button.type = "button"
        button.textContent = action.label
        if (action.title) button.title = action.title
        button.addEventListener("click", event => {
          event.stopPropagation()
          onPaneAction?.(pane.id, action.id, { pid: row.id, line: row.line })
        })
        td.appendChild(button)
      }
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  el.appendChild(table)
}

function applyTableCellFace(
  el: HTMLElement,
  face: string,
  theme: SerializedDisplayModel["theme"] | undefined,
): void {
  const resolved = themeFace(theme, face)
  if (resolved?.fg) el.style.color = resolved.fg
  if (resolved?.bg) el.style.backgroundColor = resolved.bg
}

// ── Web surface ─────────────────────────────────────────────────────────────────

/**
 * Render a declarative `WebSurfaceModel` into a pane body.
 *
 * The model is a fixed vocabulary of boxes rather than markup, so nothing a plugin
 * supplies is ever parsed as HTML. Faces resolve against the active theme, which keeps a
 * web surface consistent with the rest of the frame instead of hardcoding its own palette.
 */
function renderWebSurface(
  el: HTMLElement,
  pane: SerializedPane,
  theme: SerializedDisplayModel["theme"] | undefined,
  onPaneAction?: DomFramePaneActionHandler,
): void {
  const surface = pane.webSurface
  if (!surface) return
  el.classList.add("web-surface")

  // Reuse the existing children when they are already the right shape. Rebuilding on
  // every frame destroys and recreates the <canvas>, which the browser paints as an
  // empty pane in between -- that teardown is the visible flicker during animation.
  let root = el.querySelector<HTMLElement>(":scope > .web-surface-root")
  let canvasEl = el.querySelector<HTMLCanvasElement>(":scope > canvas.web-surface-canvas")
  const expected = (root ? 1 : 0) + (canvasEl ? 1 : 0)
  if (!root || el.childElementCount !== expected) {
    el.replaceChildren()
    root = document.createElement("div")
    root.className = "web-surface-root"
    el.appendChild(root)
    canvasEl = null
  }

  // Node trees are small and change rarely; rebuilding just this subtree is cheap and
  // avoids diffing logic that would have to track per-node identity.
  root.replaceChildren()
  for (const node of surface.nodes) root.appendChild(renderWebNode(node, pane, theme, onPaneAction))

  if (!surface.canvas) {
    canvasEl?.remove()
    return
  }
  if (!canvasEl) {
    canvasEl = document.createElement("canvas")
    canvasEl.className = "web-surface-canvas"
    el.appendChild(canvasEl)
  }
  paintCanvasSurface(canvasEl, surface.canvas, theme)
}

/**
 * URL schemes an `image` node may load.
 *
 * A surface is built by a plugin from buffer contents, so an unrestricted `src` would let
 * any opened file make the frame issue a network request. Local files and inline data are
 * all a picture viewer needs.
 */
function safeImageSrc(src: string | undefined): string | null {
  if (!src) return null
  const lower = src.trim().toLowerCase()
  if (lower.startsWith("file:")) return src.trim()
  if (lower.startsWith("data:image/")) return src.trim()
  return null
}

function renderWebNode(
  node: WebNodeModel,
  pane: SerializedPane,
  theme: SerializedDisplayModel["theme"] | undefined,
  onPaneAction?: DomFramePaneActionHandler,
): HTMLElement {
  const el = document.createElement("div")
  el.className = `web-node web-node-${node.kind}`
  if (node.id) el.dataset.nodeId = node.id
  if (node.title) el.title = node.title
  if (node.selected) el.classList.add("web-node-selected")
  // Indent in `ch` so a surface tree lines up with the same tree in the pane's body text.
  if (node.indent) el.style.marginLeft = `${node.indent * 2}ch`
  if (node.face) {
    el.dataset.face = node.face
    applyTableCellFace(el, node.face, theme)
  }
  if (node.kind === "bar") {
    const fill = document.createElement("span")
    fill.className = "web-node-bar-fill"
    fill.style.width = `${Math.max(0, Math.min(1, node.value ?? 0)) * 100}%`
    if (node.face) applyTableCellFace(fill, node.face, theme)
    el.appendChild(fill)
    if (node.text) {
      const label = document.createElement("span")
      label.className = "web-node-bar-label"
      label.textContent = node.text
      el.appendChild(label)
    }
  } else if (node.kind === "image") {
    const src = safeImageSrc(node.src)
    if (src) {
      const img = document.createElement("img")
      img.className = "web-node-image"
      img.src = src
      if (node.text) img.alt = node.text
      el.appendChild(img)
    } else {
      // A rejected or missing `src` must still say why, rather than leaving a blank pane.
      el.textContent = node.text ?? "(image not shown)"
    }
  } else if (node.text != null) {
    el.textContent = node.text
  }
  if (node.action) {
    const action = node.action
    el.classList.add("web-node-clickable")
    el.addEventListener("click", event => {
      event.stopPropagation()
      onPaneAction?.(pane.id, action, node.id ? { id: node.id } : {})
    })
  }
  for (const child of node.children ?? []) {
    el.appendChild(renderWebNode(child, pane, theme, onPaneAction))
  }
  return el
}

/**
 * Paint `canvas` into an existing <canvas> element.
 *
 * Takes the element rather than creating one so an animating surface repaints in place;
 * recreating the element each frame is what made animation flicker.
 *
 * Shape coordinates are 0..1 fractions, scaled here to the backing store size.
 */
function paintCanvasSurface(
  el: HTMLCanvasElement,
  canvas: CanvasSurfaceModel,
  theme: SerializedDisplayModel["theme"] | undefined,
): HTMLElement {
  // A fixed backing store keeps drawing deterministic; CSS stretches it to the pane.
  const width = 800
  const height = Math.max(1, Math.round(width / (canvas.aspect && canvas.aspect > 0 ? canvas.aspect : 2)))
  // Assigning width/height clears the canvas, so only do it when the size actually
  // changed; otherwise clearRect is enough and avoids a needless full reset.
  if (el.width !== width || el.height !== height) {
    el.width = width
    el.height = height
    el.style.aspectRatio = `${width} / ${height}`
  }
  const context = el.getContext?.("2d")
  if (!context) return el
  // Repainting in place means the previous frame is still on the canvas. Hosts and test
  // doubles that expose a partial 2D context may not implement clearRect, so probe it.
  context.clearRect?.(0, 0, width, height)
  const colorFor = (face: string | undefined, fallback: string) => themeFace(theme, face ?? "default")?.fg ?? fallback
  for (const shape of canvas.shapes) {
    const color = colorFor(shape.face, "#d5c4a1")
    if (shape.kind === "rect") {
      const x = shape.x * width
      const y = shape.y * height
      const w = shape.width * width
      const h = shape.height * height
      if (shape.fill === false) {
        context.strokeStyle = color
        context.strokeRect(x, y, w, h)
      } else {
        context.fillStyle = color
        context.fillRect(x, y, w, h)
      }
    } else if (shape.kind === "line") {
      context.strokeStyle = color
      context.beginPath()
      context.moveTo(shape.x1 * width, shape.y1 * height)
      context.lineTo(shape.x2 * width, shape.y2 * height)
      context.stroke()
    } else {
      context.fillStyle = color
      context.textAlign = shape.align ?? "left"
      context.fillText(shape.text, shape.x * width, shape.y * height)
    }
  }
  return el
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
      // The cursor cell is a reverse-video block; slanting it reads as a glitch.
      span.style.fontStyle = b.italic && !isCursor ? "italic" : ""
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
      const atCursor = y === surface.cursorRow && x === surface.cursorCol
      applyTerminalCell(span, atCursor ? { ...cell, italic: false } : cell)
      if (atCursor) span.classList.add("terminal-cursor")
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
  /** Tab-bar row. Optional: older embedders have no such element. */
  tabBar?: HTMLElement
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
  onPaneAction?: DomFramePaneActionHandler,
  terminalRenderer?: DomTerminalRenderer,
  onTabBar?: DomFrameTabBarHandler,
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
  if (targets.tabBar) {
    if (!prev || !sameJson(prev.model.tabBar, model.tabBar)) {
      renderThemedText(targets.tabBar, model.tabBar ?? { chunks: [] }, { defaultFontPx: defaultPx, defaultFamily })
    }
    targets.tabBar.style.display = model.tabBar ? "" : "none"
    // One listener for the element's lifetime, not one per frame: the bar's
    // text is replaced on every redisplay but the element itself is not.
    bindTabBarClicks(targets.tabBar, onTabBar)
  }

  const shape = treeShape(model.windows)
  let panes: Map<string, PaneSlot>
  let childFramesEl: HTMLElement[]
  if (prev && prev.shape === shape && sameJson(prev.model.theme, model.theme)) {
    panes = prev.panes
    forEachLeaf(model.windows, (next, grow) => {
      const slot = panes.get(next.id)!
      patchPane(slot.pane, next, slot.dom, grow, model.theme, terminalRenderer, onPaneAction)
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
      renderWindows(model.windows, onMouse, onPaneAction, terminalRenderer, 1, model.theme, panes),
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

const tabBarHandlers = new WeakMap<HTMLElement, DomFrameTabBarHandler>()

/** Attach the click listener once, then keep only the current handler live. */
function bindTabBarClicks(el: HTMLElement, onTabBar?: DomFrameTabBarHandler): void {
  const first = !tabBarHandlers.has(el)
  if (onTabBar) tabBarHandlers.set(el, onTabBar)
  else tabBarHandlers.delete(el)
  if (!first) return
  el.addEventListener("mousedown", event => {
    if (event.button !== 0) return
    const handler = tabBarHandlers.get(el)
    if (!handler) return
    event.preventDefault()
    handler(tabBarColumnAt(el, event.clientX))
  })
}

/** Character column under `clientX`, measured the same way body rows are. */
export function tabBarColumnAt(el: HTMLElement, clientX: number): number {
  const rect = el.getBoundingClientRect()
  return charOffsetAtX(el, clientX, rect.left, DOM_FRAME_COL_PX)
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
  if (targets.tabBar) applyFace(targets.tabBar, model.theme.faces["tab-bar"] ?? defaultFace, defaultFamily)
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
