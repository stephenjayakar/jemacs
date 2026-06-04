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
import { applyTheme, type Theme } from "../display/theme"
import { textWithCursor } from "./text-display"
import type { TextSpan } from "../modes/mode"

export async function startOpenTui(editor: Editor): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useKittyKeyboard: {},
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
  private body!: TextRenderable
  private modeline!: TextRenderable
  private minibuffer!: TextRenderable
  private echo!: TextRenderable
  private lastMessage = ""

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
      borderStyle: "rounded",
      padding: 0,
    })

    this.title = new TextRenderable(this.renderer, {
      id: "jemacs-title",
      content: "Jemacs OpenTUI",
    })

    this.body = new TextRenderable(this.renderer, {
      id: "jemacs-body",
      content: "",
      flexGrow: 1,
    })

    this.modeline = new TextRenderable(this.renderer, {
      id: "jemacs-modeline",
      content: "",
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
    this.root.add(this.body)
    this.root.add(this.modeline)
    this.root.add(this.minibuffer)
    this.root.add(this.echo)
    this.renderer.root.add(this.root)
  }

  async handleKey(key: KeyEvent): Promise<void> {
    await this.editor.handleKey(key)
  }

  render(): void {
    const buffer = this.editor.currentBuffer
    const { line, col } = buffer.lineCol()
    const pending = this.editor.keymaps.pendingSequence()
    const mark = buffer.mark == null ? "" : ` mark=${buffer.mark}`
    const dirty = buffer.dirty ? "*" : ""
    const depth = this.editor.minibuffer && this.editor.minibufferDepthLevel > 1
      ? ` [${this.editor.minibufferDepthLevel}]`
      : ""

    this.title.content = ` Jemacs OpenTUI — ${buffer.name}${dirty}`
    const spans = [...this.editor.fontLock(buffer)]
    if (this.editor.isearch) {
      const match = isearchMatchSpan(buffer, this.editor.isearch)
      if (match) spans.push(match)
    }
    this.body.content = visibleStyledText(buffer.text, buffer.point, {
      mark: buffer.markActive ? buffer.mark : null,
      spans,
      theme: this.editor.theme,
    })
    this.modeline.content = this.editor.minibuffer
      ? ` Minibuffer${depth}  ${this.editor.activeBuffer.mode}  line ${this.editor.activeBuffer.lineCol().line}, col ${this.editor.activeBuffer.lineCol().col}${pending ? `  [${pending}]` : ""}`
      : ` ${buffer.mode}  ${buffer.name}${dirty}  line ${line}, col ${col}  point ${buffer.point}${mark}${pending ? `  [${pending}]` : ""}`
    this.minibuffer.content = this.editor.minibuffer
      ? ` ${this.editor.minibuffer.prompt}${textWithCursor(this.editor.activeBuffer.text, this.editor.activeBuffer.point)}`
      : this.editor.isearch
        ? ` ${textWithCursor(isearchPrompt(this.editor.isearch), this.editor.isearch.string.length)}`
        : " "
    this.echo.content = ` ${this.lastMessage}`
  }
}

export function visibleText(text: string, point: number): string {
  return visibleTextRegion(text, point).visible
}

export function visibleStyledText(text: string, point: number, options: { mark?: number | null, markActive?: boolean, spans?: TextSpan[], theme: Theme }): StyledText {
  const region = visibleTextRegion(text, point)
  const visibleEnd = region.visibleStart + region.visible.length
  const spans = options.spans ?? []
  const mark = options.markActive === false ? null : (options.mark ?? null)
  const allSpans: TextSpan[] = mark == null || mark === point
    ? spans
    : [...spans, { start: Math.min(mark, point), end: Math.max(mark, point), face: "region" }]
  const visibleSpans = allSpans
    .filter(span => span.end > region.visibleStart && span.start < visibleEnd)
    .map(span => ({ ...span, start: Math.max(0, span.start - region.visibleStart), end: Math.min(region.visible.length, span.end - region.visibleStart) }))
  return applyTheme(region.visible, visibleSpans, options.theme)
}

export function pageScrollLines(): number {
  const rows = process.stdout.rows ?? 30
  return Math.max(1, rows - 6)
}

function visibleTextRegion(text: string, point: number): { visible: string, visibleStart: number } {
  const cursorPoint = Math.max(0, Math.min(point, text.length))
  const withCursor = textWithCursor(text, point)
  const lines = withCursor.split("\n")
  const maxLines = pageScrollLines()
  const cursorLine = withCursor.slice(0, cursorPoint).split("\n").length - 1
  const start = Math.max(0, Math.min(cursorLine - Math.floor(maxLines / 2), lines.length - maxLines))
  const visibleStart = lines.slice(0, start).join("\n").length + (start > 0 ? 1 : 0)
  const visible = lines.slice(start, start + maxLines).join("\n")
  return { visible, visibleStart }
}
