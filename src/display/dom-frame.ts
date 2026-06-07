/// <reference lib="dom" />
import type { SerializedDisplayModel, SerializedThemedText, SerializedWindowNode } from "./serialize"
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
  options: { textScale?: number; defaultFontPx?: number } = {},
): void {
  const span = document.createElement("span")
  span.textContent = chunk.text
  if (chunk.fg) span.style.color = chunk.fg
  if (chunk.bg) span.style.backgroundColor = chunk.bg
  if (chunk.bold) span.style.fontWeight = "bold"
  if (chunk.italic) span.style.fontStyle = "italic"
  if (chunk.underline) span.style.textDecoration = "underline"
  if (chunk.family) span.style.fontFamily = chunk.family
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
  options: { textScale?: number; defaultFontPx?: number } = {},
): void {
  el.replaceChildren()
  for (const chunk of model.chunks) renderChunk(el, chunk, options)
}

export type DomFrameMouseHandler = (windowId: string, row: number, col: number) => void

export function renderWindows(
  node: SerializedWindowNode,
  onMouse?: DomFrameMouseHandler,
  grow = 1,
  theme?: SerializedDisplayModel["theme"],
): HTMLElement {
  if (node.kind === "leaf") {
    const pane = document.createElement("div")
    pane.className = `window-pane${node.pane.selected ? " selected" : ""}`
    pane.dataset.windowId = node.pane.id
    pane.style.flexGrow = String(Math.max(0.05, grow))
    const defaultFace = themeFace(theme, "default")
    const modelineFace = themeFace(theme, node.pane.selected ? "modeLine" : "modeLineInactive")
    if (defaultFace?.bg) pane.style.backgroundColor = defaultFace.bg
    if (modelineFace?.bg) pane.style.borderColor = modelineFace.bg
    const textScale = node.pane.textScale ?? 1
    const rowPx = DOM_FRAME_ROW_PX * textScale
    const colPx = DOM_FRAME_COL_PX * textScale
    const sendMouse = (event: MouseEvent, target: HTMLElement) => {
      if (event.button !== 0 || !onMouse) return
      const rect = target.getBoundingClientRect()
      const row = Math.max(0, Math.floor((event.clientY - rect.top) / rowPx))
      const col = Math.max(0, Math.floor((event.clientX - rect.left) / colPx))
      onMouse(node.pane.id, row, col)
    }
    const body = document.createElement("div")
    body.className = "window-body"
    if (defaultFace?.bg) body.style.backgroundColor = defaultFace.bg
    if (defaultFace?.family) body.style.fontFamily = defaultFace.family
    const bodyDefaultPx = defaultFace?.height != null ? defaultFace.height / 10 : DOM_FRAME_BODY_FONT_PX
    body.style.fontSize = `${bodyDefaultPx * textScale}px`
    body.style.lineHeight = String(DOM_FRAME_LINE_HEIGHT_RATIO)
    if (node.pane.terminalSurface) renderTerminalSurface(body, node.pane.terminalSurface)
    else renderThemedText(body, node.pane.body, { textScale, defaultFontPx: bodyDefaultPx })
    body.addEventListener("mousedown", event => sendMouse(event, body))
    pane.addEventListener("mousedown", event => {
      if (event.target === pane) sendMouse(event, body)
    })
    const modeline = document.createElement("div")
    modeline.className = "window-modeline"
    if (modelineFace?.bg) modeline.style.backgroundColor = modelineFace.bg
    if (modelineFace?.fg) modeline.style.color = modelineFace.fg
    const modelineDefaultPx = modelineFace?.height != null ? modelineFace.height / 10 : DOM_FRAME_MODELINE_FONT_PX
    modeline.style.fontSize = `${modelineDefaultPx * textScale}px`
    if (modelineFace?.family) modeline.style.fontFamily = modelineFace.family
    renderThemedText(modeline, node.pane.modeline, { textScale, defaultFontPx: modelineDefaultPx })
    pane.append(body, modeline)
    return pane
  }
  const split = document.createElement("div")
  split.className = node.direction === "vertical" ? "split-col" : "split-row"
  split.style.flexGrow = String(Math.max(0.05, grow))
  const firstRatio = node.firstRatio ?? 0.5
  split.append(renderWindows(node.first, onMouse, firstRatio, theme), renderWindows(node.second, onMouse, 1 - firstRatio, theme))
  return split
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

export function presentDomFrame(
  targets: DomFrameTargets,
  model: SerializedDisplayModel,
  onMouse?: DomFrameMouseHandler,
): void {
  applyThemeSurfaces(targets, model)
  const defaultFace = model.theme.faces.default
  const titleFace = model.theme.faces.title ?? defaultFace
  const defaultPx = defaultFace?.height != null ? defaultFace.height / 10 : DOM_FRAME_BODY_FONT_PX
  renderThemedText(targets.title, model.title, { defaultFontPx: defaultPx })
  targets.windows.replaceChildren(renderWindows(model.windows, onMouse, 1, model.theme))
  if (targets.minibufferCompletions) {
    renderThemedText(targets.minibufferCompletions, model.minibufferCompletions, { defaultFontPx: defaultPx })
    targets.minibufferCompletions.style.display = model.minibufferCompletionLines > 0 ? "" : "none"
  }
  renderThemedText(targets.minibuffer, model.minibuffer, { defaultFontPx: defaultPx })
  renderThemedText(targets.echo, model.echo, { defaultFontPx: defaultPx })
}

function applyThemeSurfaces(targets: DomFrameTargets, model: SerializedDisplayModel): void {
  const defaultFace = model.theme.faces.default
  const titleFace = model.theme.faces.title ?? defaultFace
  const minibufferFace = model.theme.faces.minibuffer ?? defaultFace
  const bg = defaultFace?.bg
  const fg = defaultFace?.fg
  const root = document.getElementById("jemacs-root")
  for (const el of [document.documentElement, document.body, root, targets.windows]) {
    if (!el) continue
    if (bg) el.style.backgroundColor = bg
    if (fg) el.style.color = fg
    if (defaultFace?.family) el.style.fontFamily = defaultFace.family
  }
  applyFace(targets.title, titleFace)
  if (targets.minibufferCompletions) applyFace(targets.minibufferCompletions, minibufferFace)
  applyFace(targets.minibuffer, minibufferFace)
  applyFace(targets.echo, minibufferFace)
}

function applyFace(el: HTMLElement, face: { fg?: string; bg?: string; family?: string; height?: number } | undefined): void {
  if (face?.bg) el.style.backgroundColor = face.bg
  if (face?.fg) el.style.color = face.fg
  if (face?.family) el.style.fontFamily = face.family
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
