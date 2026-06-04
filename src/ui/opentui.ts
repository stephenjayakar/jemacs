import {
  BoxRenderable,
  TextRenderable,
  createCliRenderer,
  type KeyEvent,
  type CliRenderer,
  type StyledText,
} from "@opentui/core"
import type { Editor } from "../kernel/editor"
import { isearchMatchSpan, isearchPrompt } from "../kernel/isearch"
import { findWindowLeaf, type WindowLeaf, type WindowNode } from "../kernel/window"
import { applyTheme, type Theme } from "../display/theme"
import { textWithCursor } from "./text-display"
import {
  adjustSpansForLineNumbers,
  firstVisibleLineNumber,
  formatWithLineNumbers,
  gutterSpans,
  regionSpansWithLineNumbers,
} from "./line-numbers"
import type { TextSpan } from "../modes/mode"
import { keyEventFromOpentui } from "./opentui-key"

export async function startOpenTui(editor: Editor): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useKittyKeyboard: {
      disambiguate: true,
      alternateKeys: true,
      reportText: true,
    },
  })

  const ui = new EditorUi(renderer, editor)
  ui.mount()

  renderer.keyInput.on("keypress", async (key: KeyEvent) => {
    try {
      await ui.handleKey(key)
    } catch (error) {
      editor.message(error instanceof Error ? error.stack ?? error.message : String(error))
    }
  })

  renderer.keyInput.on("paste", event => {
    const text = new TextDecoder().decode(event.bytes)
    editor.activeBuffer.insert(text)
    void editor.changed("paste")
  })

  editor.events.on("changed", () => {
    ui.render()
    if (!editor.running) {
      renderer.destroy()
    }
  })

  ui.render()
}

class EditorUi {
  private root!: BoxRenderable
  private title!: TextRenderable
  private windowsRoot!: BoxRenderable
  private minibuffer!: TextRenderable
  private echo!: TextRenderable
  private lastMessage = ""
  private splitPanes = new Map<string, BoxRenderable>()
  private leafPanes = new Map<string, { pane: BoxRenderable; body: TextRenderable; modeline: TextRenderable }>()

  constructor(private readonly renderer: CliRenderer, private readonly editor: Editor) {
    editor.events.on("message", ({ text }) => {
      this.lastMessage = text
    })
  }

  mount(): void {
    this.root = new BoxRenderable(this.renderer, {
      id: "jemacs-root",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      border: false,
      padding: 0,
    })

    this.title = new TextRenderable(this.renderer, {
      id: "jemacs-title",
      content: "Jemacs OpenTUI",
    })

    this.windowsRoot = new BoxRenderable(this.renderer, {
      id: "jemacs-windows",
      flexDirection: "column",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      width: "100%",
      height: "100%",
    })

    this.minibuffer = new TextRenderable(this.renderer, {
      id: "jemacs-minibuffer",
      content: "",
    })

    this.echo = new TextRenderable(this.renderer, {
      id: "jemacs-echo",
      content: "",
    })

    this.root.add(this.title)
    this.root.add(this.windowsRoot)
    this.root.add(this.minibuffer)
    this.root.add(this.echo)
    this.renderer.root.add(this.root)
  }

  async handleKey(key: KeyEvent): Promise<void> {
    await this.editor.handleKey(keyEventFromOpentui(key))
  }

  render(): void {
    const buffer = this.editor.currentBuffer
    const pending = this.editor.keymaps.pendingSequence()
    const depth = this.editor.minibuffer && this.editor.minibufferDepthLevel > 1
      ? ` [${this.editor.minibufferDepthLevel}]`
      : ""

    this.title.content = ` Jemacs OpenTUI — ${buffer.name}${buffer.dirty ? "*" : ""}`
    this.renderWindows(this.editor.windowLayout, contentAreaLines())
    this.minibuffer.content = this.editor.minibuffer
      ? `${depth} ${this.editor.minibuffer.prompt}${textWithCursor(this.editor.activeBuffer.text, this.editor.activeBuffer.point)}`
      : this.editor.isearch
        ? ` ${textWithCursor(isearchPrompt(this.editor.isearch), this.editor.isearch.string.length)}`
        : " "
    this.echo.content = ` ${this.lastMessage}${pending && !this.editor.minibuffer ? `  [${pending}]` : ""}`
  }

  private renderWindows(layout: WindowNode, availableLines: number): void {
    const seenSplits = new Set<string>()
    const seenLeaves = new Set<string>()
    this.syncWindowNode(this.windowsRoot, layout, availableLines, "column", "root", seenSplits, seenLeaves)
    for (const [key, pane] of this.splitPanes) {
      if (seenSplits.has(key)) continue
      pane.destroyRecursively()
      this.splitPanes.delete(key)
    }
    for (const [id, parts] of this.leafPanes) {
      if (seenLeaves.has(id)) continue
      parts.pane.destroyRecursively()
      this.leafPanes.delete(id)
    }
  }

  private syncWindowNode(
    parent: BoxRenderable,
    layout: WindowNode,
    availableLines: number,
    parentAxis: "row" | "column",
    path: string,
    seenSplits: Set<string>,
    seenLeaves: Set<string>,
  ): void {
    if (layout.kind === "leaf") {
      seenLeaves.add(layout.id)
      let parts = this.leafPanes.get(layout.id)
      if (!parts) {
        const pane = new BoxRenderable(this.renderer, {
          id: `window:${layout.id}`,
          flexDirection: "column",
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: 0,
          minWidth: 0,
          minHeight: 0,
          border: false,
        })
        const body = new TextRenderable(this.renderer, { id: `window-body:${layout.id}`, content: "", flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0 })
        const modeline = new TextRenderable(this.renderer, { id: `window-modeline:${layout.id}`, content: "" })
        pane.add(body)
        pane.add(modeline)
        parts = { pane, body, modeline }
        this.leafPanes.set(layout.id, parts)
      }
      this.applyPaneLayout(parts.pane, parentAxis)
      this.reparent(parts.pane, parent)
      this.updateLeafContent(parts, layout, availableLines)
      return
    }

    const key = `${path}:${layout.direction}`
    seenSplits.add(key)
    const axis = layout.direction === "vertical" ? "column" : "row"
    let container = this.splitPanes.get(key)
    if (!container) {
      container = new BoxRenderable(this.renderer, {
        id: `split:${key}`,
        flexDirection: axis,
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        minWidth: 0,
        minHeight: 0,
      })
      this.splitPanes.set(key, container)
    } else {
      container.flexDirection = axis
    }
    this.applyPaneLayout(container, parentAxis)
    this.reparent(container, parent)

    const { first, second } = this.splitLineBudget(availableLines, layout.direction)
    this.syncWindowNode(container, layout.first, first, axis, `${path}/f`, seenSplits, seenLeaves)
    this.syncWindowNode(container, layout.second, second, axis, `${path}/s`, seenSplits, seenLeaves)
    this.ensureSplitChildren(container)
  }

  private reparent(pane: BoxRenderable, parent: BoxRenderable): void {
    if (pane.parent === parent) return
    if (pane.parent) pane.parent.remove(pane.id)
    parent.add(pane)
  }

  private ensureSplitChildren(container: BoxRenderable): void {
    for (const child of container.getChildren().slice(2)) {
      container.remove(child.id)
    }
  }

  private applyPaneLayout(pane: BoxRenderable, parentAxis: "row" | "column"): void {
    pane.flexGrow = 1
    pane.flexShrink = 1
    pane.flexBasis = 0
    pane.minWidth = 0
    pane.minHeight = 0
    if (parentAxis === "column") pane.width = "100%"
    else pane.height = "100%"
  }

  private splitLineBudget(availableLines: number, direction: "horizontal" | "vertical"): { first: number; second: number } {
    if (direction === "horizontal") {
      return { first: availableLines, second: availableLines }
    }
    const first = Math.max(3, Math.floor(availableLines / 2))
    return { first, second: Math.max(3, availableLines - first) }
  }

  private updateLeafContent(
    parts: { pane: BoxRenderable; body: TextRenderable; modeline: TextRenderable },
    leaf: WindowLeaf,
    availableLines: number,
  ): void {
    const { body, modeline } = parts
    const selected = leaf.id === this.editor.selectedWindowId
    const buffer = this.editor.buffers.get(leaf.bufferId)
    if (!buffer) {
      body.content = ""
      modeline.content = applyTheme(" (empty)", [], this.editor.theme)
      return
    }

    const point = selected ? buffer.point : leaf.point
    const dirty = buffer.dirty ? "*" : ""
    const { line, col } = pointLineCol(buffer.text, point)
    const maxLines = Math.max(1, availableLines - 1)
    if (selected) this.editor.syncSelectedWindowViewport(maxLines)
    const startLine = findWindowLeaf(this.editor.windowLayout, leaf.id)?.startLine ?? leaf.startLine

    const spans = [...this.editor.fontLock(buffer)]
    if (selected && this.editor.isearch) {
      const match = isearchMatchSpan(buffer, this.editor.isearch)
      if (match) spans.push(match)
    }
    const showLineNumbers = buffer.kind !== "minibuffer" && this.editor.showLineNumbers(buffer)
    body.content = visibleStyledTextFromStart(buffer.text, point, startLine, {
      mark: selected ? buffer.mark : null,
      spans,
      theme: this.editor.theme,
      maxLines,
      showLineNumbers,
      showCursor: selected,
    })
    const lighters = this.editor.minorModeLighters(buffer)
    const modelineText = ` ${buffer.mode}${lighters}  ${buffer.name}${dirty}${leaf.dedicated ? " [D]" : ""}  line ${line}, col ${col}${selected && buffer.mark != null ? `  mark=${buffer.mark}` : ""}`
    modeline.content = applyTheme(modelineText, [{
      start: 0,
      end: modelineText.length,
      face: selected ? "modeLine" : "modeLineInactive",
    }], this.editor.theme)
  }
}

function pointLineCol(text: string, point: number): { line: number; col: number } {
  const before = text.slice(0, Math.max(0, Math.min(point, text.length)))
  const lines = before.split("\n")
  return { line: lines.length, col: lines.at(-1)!.length + 1 }
}

export function visibleText(text: string, point: number): string {
  return visibleTextRegion(text, point).visible
}

export function visibleStyledText(
  text: string,
  point: number,
  options: { mark?: number | null, markActive?: boolean, spans?: TextSpan[], theme: Theme, maxLines?: number, showLineNumbers?: boolean },
): StyledText {
  const region = visibleTextRegion(text, point, options.maxLines)
  return styledRegion(text, region, point, options)
}

export function visibleStyledTextFromStart(
  text: string,
  point: number,
  startLine: number,
  options: {
    spans?: TextSpan[]
    theme: Theme
    maxLines?: number
    showLineNumbers?: boolean
    mark?: number | null
    markActive?: boolean
    showCursor?: boolean
  },
): StyledText {
  const region = visibleTextRegionFromStart(text, startLine, options.maxLines)
  return styledRegion(text, region, point, options)
}

function styledRegion(
  text: string,
  region: { visible: string; visibleStart: number },
  point: number,
  options: {
    mark?: number | null
    markActive?: boolean
    spans?: TextSpan[]
    theme: Theme
    showLineNumbers?: boolean
    showCursor?: boolean
  },
): StyledText {
  const visibleEnd = region.visibleStart + region.visible.length
  const spans = options.spans ?? []
  const mark = options.mark ?? null
  const allSpans: TextSpan[] = mark == null || mark === point
    ? spans
    : [...spans, { start: Math.min(mark, point), end: Math.max(mark, point), face: "region" }]
  const visibleSpans = allSpans
    .filter(span => span.end > region.visibleStart && span.start < visibleEnd)
    .map(span => ({ ...span, start: Math.max(0, span.start - region.visibleStart), end: Math.min(region.visible.length, span.end - region.visibleStart) }))
  let visible = region.visible
  if (options.showCursor && point >= region.visibleStart && point <= visibleEnd) {
    visible = textWithCursor(region.visible, point - region.visibleStart)
  }
  if (!options.showLineNumbers) return applyTheme(visible, visibleSpans, options.theme)

  const firstLine = firstVisibleLineNumber(region.visibleStart, text)
  const format = formatWithLineNumbers(visible, firstLine)
  const contentSpans = visibleSpans.filter(span => span.face !== "region")
  const regionBounds = visibleSpans.filter(span => span.face === "region")
  const regionSpans = regionBounds.length
    ? regionSpansWithLineNumbers(
      Math.min(...regionBounds.map(span => span.start)),
      Math.max(...regionBounds.map(span => span.end)),
      visible,
      format,
    )
    : []
  const displaySpans = [
    ...gutterSpans(format.text, format.prefixLen),
    ...adjustSpansForLineNumbers(contentSpans, visible, format.prefixLen),
    ...regionSpans,
  ]
  return applyTheme(format.text, displaySpans, options.theme)
}

export function visibleTextRegionFromStart(text: string, startLine: number, lineBudget = pageScrollLines()): { visible: string, visibleStart: number } {
  const lines = text.split("\n")
  const start = Math.max(0, Math.min(startLine, Math.max(0, lines.length - lineBudget)))
  const visibleStart = lines.slice(0, start).join("\n").length + (start > 0 ? 1 : 0)
  const visible = lines.slice(start, start + lineBudget).join("\n")
  return { visible, visibleStart }
}

export function pageScrollLines(): number {
  const rows = process.stdout.rows ?? 30
  return Math.max(1, rows - 6)
}

export function contentAreaLines(): number {
  return Math.max(3, pageScrollLines() - 1)
}

function visibleTextRegion(text: string, point: number, lineBudget = pageScrollLines()): { visible: string, visibleStart: number } {
  const cursorPoint = Math.max(0, Math.min(point, text.length))
  const withCursor = textWithCursor(text, point)
  const lines = withCursor.split("\n")
  const cursorLine = withCursor.slice(0, cursorPoint).split("\n").length - 1
  const start = Math.max(0, Math.min(cursorLine - Math.floor(lineBudget / 2), lines.length - lineBudget))
  const visibleStart = lines.slice(0, start).join("\n").length + (start > 0 ? 1 : 0)
  const visible = lines.slice(start, start + lineBudget).join("\n")
  return { visible, visibleStart }
}
