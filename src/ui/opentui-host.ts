import {
  BoxRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
  type CliRenderer,
  type MouseEvent,
} from "@opentui/core"
import { buildDisplayModel } from "../display/build-display-model"
import type {
  DisplayModel,
  InputHandler,
  ResizeHandler,
  UiHost,
  WindowDisplayNode,
  WindowPaneModel,
} from "../display/protocol"
import { themeFaceBackground, type Theme } from "../display/theme"
import { terminalSurfaceToThemedText } from "../display/terminal-surface"
import type { FaceName } from "../modes/mode"
import { contentAreaLines, defaultTerminalRows, type ViewportSize } from "../display/viewport"
import { keyEventFromOpentui } from "./opentui-key"
import { themedTextToStyledText } from "./opentui-styled"
import { syncTextareaFromSpans, syntaxForTheme } from "./opentui-textarea-sync"

type BodyRenderable = TextRenderable | TextareaRenderable | ScrollBoxRenderable
type BodyKind = "text" | "textarea" | "markdown"

/** Opt-in native editor surface for the selected window (`JEMACS_USE_TEXTAREA=1`). */
function useTextareaEditor(): boolean {
  return process.env.JEMACS_USE_TEXTAREA === "1"
}

export class OpenTuiHost implements UiHost {
  readonly label = "Jemacs OpenTUI"
  readonly capabilities = {
    unit: "cells" as const,
    mouse: true,
    clipboard: true,
    osc52: true,
    perFaceFonts: false,
    terminalSurfaces: true,
  }

  private renderer!: CliRenderer
  private root!: BoxRenderable
  private title!: TextRenderable
  private windowsRoot!: BoxRenderable
  private minibufferCompletions!: TextRenderable
  private minibuffer!: TextRenderable
  private echo!: TextRenderable
  private splitPanes = new Map<string, BoxRenderable>()
  private leafPanes = new Map<string, { pane: BoxRenderable; body: BodyRenderable; modeline: TextRenderable; kind: BodyKind }>()
  private inputHandlers: InputHandler[] = []
  private resizeHandlers: ResizeHandler[] = []
  private bodyWindowIds = new WeakMap<BodyRenderable, string>()

  /** Use an existing renderer (e.g. `createTestRenderer`) for automated tests. */
  static async forRenderer(renderer: CliRenderer): Promise<OpenTuiHost> {
    const host = new OpenTuiHost()
    host.renderer = renderer
    host.mount()
    return host
  }

  async start(): Promise<void> {
    this.renderer = await createCliRenderer({
      exitOnCtrlC: false,
      useMouse: true,
      useKittyKeyboard: {
        disambiguate: true,
        alternateKeys: true,
        reportText: true,
      },
    })
    this.mount()
    this.attachInput()
    this.renderer.on("resize", (width, height) => {
      const viewport = { rows: height, cols: width }
      for (const handler of this.resizeHandlers) handler(viewport)
    })
  }

  destroy(): void {
    if (this.renderer && !this.renderer.isDestroyed) {
      this.renderer.destroy()
    }
  }

  getViewport(): ViewportSize {
    if (this.renderer && !this.renderer.isDestroyed) {
      return { rows: this.renderer.height, cols: this.renderer.width }
    }
    return { rows: defaultTerminalRows() }
  }

  present(model: DisplayModel): void {
    this.applyThemeSurfaces(model.theme)
    this.title.content = themedTextToStyledText(model.title)
    this.renderWindows(model.windows, Math.max(2, contentAreaLines(model.viewport.rows) - model.minibufferCompletionLines), model.theme)
    this.minibufferCompletions.content = themedTextToStyledText(model.minibufferCompletions)
    this.minibufferCompletions.height = model.minibufferCompletionLines
    this.minibuffer.content = themedTextToStyledText(model.minibuffer)
    this.echo.content = themedTextToStyledText(model.echo)
    // Input/resize trigger frames implicitly; async sources (term, LSP, timers)
    // call present() via changed() and need an explicit frame request.
    this.renderer?.requestRender()
  }

  onInput(handler: InputHandler): void {
    this.inputHandlers.push(handler)
  }

  onResize(handler: ResizeHandler): void {
    this.resizeHandlers.push(handler)
  }

  private attachInput(): void {
    this.renderer.keyInput.on("keypress", async key => {
      for (const handler of this.inputHandlers) {
        await handler({ type: "key", key: keyEventFromOpentui(key) })
      }
    })
    this.renderer.keyInput.on("paste", event => {
      const text = new TextDecoder().decode(event.bytes)
      for (const handler of this.inputHandlers) {
        void handler({ type: "paste", text })
      }
    })
  }

  private wireBodyMouse(body: BodyRenderable): void {
    body.onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return
      const windowId = this.bodyWindowIds.get(body)
      if (!windowId) return
      event.stopPropagation()
      const row = Math.max(0, event.y - body.y)
      const col = Math.max(0, event.x - body.x)
      for (const handler of this.inputHandlers) {
        void handler({ type: "mouse", windowId, row, col, button: event.button })
      }
    }
  }

  private mount(): void {
    this.root = new BoxRenderable(this.renderer, {
      id: "jemacs-root",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      border: false,
      padding: 0,
    })
    this.title = new TextRenderable(this.renderer, { id: "jemacs-title", content: "" })
    this.windowsRoot = new BoxRenderable(this.renderer, {
      id: "jemacs-windows",
      flexDirection: "column",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      width: "100%",
      height: "100%",
    })
    this.minibufferCompletions = new TextRenderable(this.renderer, { id: "jemacs-minibuffer-completions", content: "", height: 0 })
    this.minibuffer = new TextRenderable(this.renderer, { id: "jemacs-minibuffer", content: "" })
    this.echo = new TextRenderable(this.renderer, { id: "jemacs-echo", content: "" })
    this.root.add(this.title)
    this.root.add(this.windowsRoot)
    this.root.add(this.minibufferCompletions)
    this.root.add(this.minibuffer)
    this.root.add(this.echo)
    this.renderer.root.add(this.root)
  }

  private applyThemeSurfaces(theme: Theme): void {
    fillBox(this.root, themeFaceBackground(theme))
    fillBox(this.windowsRoot, themeFaceBackground(theme))
    this.applyTextBackground(this.title, theme, "title")
    this.applyTextBackground(this.minibufferCompletions, theme, "minibuffer")
    this.applyTextBackground(this.minibuffer, theme, "minibuffer")
    this.applyTextBackground(this.echo, theme, "minibuffer")
    for (const { pane, body } of this.leafPanes.values()) {
      fillBox(pane, themeFaceBackground(theme))
      this.applyTextBackground(body, theme)
    }
  }

  private applyTextBackground(text: BodyRenderable, theme: Theme, face: FaceName = "default"): void {
    if (text instanceof TextareaRenderable) return
    const bg = themeFaceBackground(theme, face)
    if (!bg) return
    if (text instanceof ScrollBoxRenderable) fillBox(text, bg)
    else text.bg = bg
  }

  private renderWindows(layout: WindowDisplayNode, availableLines: number, theme: Theme): void {
    const seenSplits = new Set<string>()
    const seenLeaves = new Set<string>()
    this.syncWindowNode(this.windowsRoot, layout, availableLines, "column", "root", seenSplits, seenLeaves, theme)
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
    layout: WindowDisplayNode,
    availableLines: number,
    parentAxis: "row" | "column",
    path: string,
    seenSplits: Set<string>,
    seenLeaves: Set<string>,
    theme: Theme,
    grow = 1,
  ): void {
    if (layout.kind === "leaf") {
      const leaf = layout.pane
      seenLeaves.add(leaf.id)
      let parts = this.leafPanes.get(leaf.id)
      const wantKind: BodyKind = leaf.markdownSurface ? "markdown" : useTextareaEditor() && leaf.selected ? "textarea" : "text"
      if (!parts || parts.kind !== wantKind) {
        if (parts) {
          parts.pane.destroyRecursively()
          this.leafPanes.delete(leaf.id)
        }
        parts = this.createLeafPane(leaf.id, wantKind)
        this.leafPanes.set(leaf.id, parts)
        this.bodyWindowIds.set(parts.body, leaf.id)
        this.wireBodyMouse(parts.body)
      } else {
        this.bodyWindowIds.set(parts.body, leaf.id)
      }
      this.applyPaneLayout(parts.pane, parentAxis, grow)
      this.reparent(parts.pane, parent)
      this.updateLeafBody(parts.body, leaf, theme)
      parts.modeline.content = themedTextToStyledText(leaf.modeline)
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
    this.applyPaneLayout(container, parentAxis, grow)
    this.reparent(container, parent)

    const budget = layout.kind === "split"
      ? this.splitLineBudget(availableLines, layout.direction, layout.firstRatio)
      : { first: availableLines, second: availableLines }
    const firstRatio = layout.firstRatio ?? 0.5
    this.syncWindowNode(container, layout.first, budget.first, axis, `${path}/f`, seenSplits, seenLeaves, theme, firstRatio)
    this.syncWindowNode(container, layout.second, budget.second, axis, `${path}/s`, seenSplits, seenLeaves, theme, 1 - firstRatio)
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

  private applyPaneLayout(pane: BoxRenderable, parentAxis: "row" | "column", grow = 1): void {
    pane.flexGrow = Math.max(0.05, grow)
    pane.flexShrink = 1
    pane.flexBasis = 0
    pane.minWidth = 0
    pane.minHeight = 0
    if (parentAxis === "column") pane.width = "100%"
    else pane.height = "100%"
  }

  private splitLineBudget(availableLines: number, direction: "horizontal" | "vertical", firstRatio = 0.5): { first: number; second: number } {
    if (direction === "horizontal") {
      return { first: availableLines, second: availableLines }
    }
    const first = proportionalBudget(availableLines, firstRatio, 3)
    return { first, second: Math.max(3, availableLines - first) }
  }

  private createLeafPane(windowId: string, kind: BodyKind) {
    const pane = new BoxRenderable(this.renderer, {
      id: `window:${windowId}`,
      flexDirection: "column",
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: 0,
      minHeight: 0,
      border: false,
    })
    const body = kind === "textarea"
      ? new TextareaRenderable(this.renderer, {
        id: `window-body:${windowId}`,
        focusable: false,
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        minHeight: 0,
        showCursor: true,
        wrapMode: "word",
      })
      : kind === "markdown"
        ? new ScrollBoxRenderable(this.renderer, {
          id: `window-body:${windowId}`,
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: 0,
          minHeight: 0,
          scrollY: true,
          scrollX: false,
          stickyScroll: false,
          viewportCulling: true,
        })
      : new TextRenderable(this.renderer, {
        id: `window-body:${windowId}`,
        content: "",
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        minHeight: 0,
      })
    const modeline = new TextRenderable(this.renderer, { id: `window-modeline:${windowId}`, content: "" })
    pane.add(body)
    pane.add(modeline)
    return { pane, body, modeline, kind }
  }

  private updateLeafBody(body: BodyRenderable, leaf: WindowPaneModel, theme: Theme): void {
    if (body instanceof ScrollBoxRenderable) {
      this.syncMarkdownBody(body, leaf, theme)
      return
    }
    if (body instanceof TextareaRenderable) {
      syncTextareaFromSpans(body, {
        text: leaf.syncText,
        point: leaf.syncPoint,
        spans: leaf.syncSpans,
        theme,
        selected: leaf.selected,
      })
      return
    }
    body.content = themedTextToStyledText(leaf.terminalSurface ? terminalSurfaceToThemedText(leaf.terminalSurface) : leaf.body)
  }

  private syncMarkdownBody(body: ScrollBoxRenderable, leaf: WindowPaneModel, theme: Theme): void {
    const surface = leaf.markdownSurface
    if (!surface) return
    let markdown = body.getRenderable(`window-markdown:${leaf.id}`) as MarkdownRenderable | undefined
    const bg = themeFaceBackground(theme)
    if (!markdown) {
      markdown = new MarkdownRenderable(this.renderer, {
        id: `window-markdown:${leaf.id}`,
        content: surface.content,
        syntaxStyle: syntaxForTheme(theme),
        conceal: true,
        concealCode: true,
        streaming: false,
        internalBlockMode: "top-level",
        tableOptions: {
          style: "grid",
          widthMode: "full",
          wrapMode: "word",
          borders: true,
          selectable: true,
        },
        fg: theme.faces.default?.fg,
        bg,
        width: "100%",
      })
      body.add(markdown)
    } else {
      markdown.content = surface.content
      markdown.syntaxStyle = syntaxForTheme(theme)
      markdown.conceal = true
      markdown.concealCode = true
      markdown.tableOptions = {
        style: "grid",
        widthMode: "full",
        wrapMode: "word",
        borders: true,
        selectable: true,
      }
      markdown.fg = theme.faces.default?.fg
      markdown.bg = bg
    }
    body.scrollTop = Math.max(0, surface.startLine)
  }
}

function fillBox(box: BoxRenderable, backgroundColor: string | undefined): void {
  if (!backgroundColor) return
  box.backgroundColor = backgroundColor
  box.shouldFill = true
}

function proportionalBudget(total: number, firstRatio: number, min: number): number {
  if (total <= min * 2) return Math.floor(total / 2)
  const ratio = Math.max(0.05, Math.min(0.95, firstRatio))
  return Math.max(min, Math.min(total - min, Math.floor(total * ratio)))
}
