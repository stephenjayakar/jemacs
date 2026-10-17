import {
  App,
  debounce,
  Editor,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian"
// Same parser jemacs' critique-mode uses, so both sides agree on the syntax.
import {
  formatCritiqueComment,
  parseCritiqueComments,
  type CritiqueComment,
  type CritiqueSyntax,
} from "../../plugins/critique/parse"
import {
  critiqueEdit,
  critiqueEditorExtension,
  critiqueReadingProcessor,
  type CritiqueChange,
  type NoteHost,
} from "./notes"

const VIEW_TYPE = "critique-comments"

type CritiqueSettings = { syntax: CritiqueSyntax }
const DEFAULT_SETTINGS: CritiqueSettings = { syntax: "obsidian" }

export default class CritiquePlugin extends Plugin {
  settings: CritiqueSettings = { ...DEFAULT_SETTINGS }
  /** Last focused markdown view; the sidebar keeps showing it while focused itself. */
  target: MarkdownView | null = null

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) }
    this.registerView(VIEW_TYPE, leaf => new CritiqueView(leaf, this))
    this.addRibbonIcon("message-square", "Open comments", () => void this.activateView())
    this.addSettingTab(new CritiqueSettingTab(this.app, this))

    this.addCommand({
      id: "open-comments",
      name: "Open comments panel",
      callback: () => void this.activateView(),
    })
    this.addCommand({
      id: "add-comment",
      name: "Comment on selection",
      editorCallback: (editor: Editor) => this.addComment(editor),
    })
    this.addCommand({
      id: "next-comment",
      name: "Go to next comment",
      editorCallback: (editor: Editor) => this.step(editor, 1),
    })
    this.addCommand({
      id: "previous-comment",
      name: "Go to previous comment",
      editorCallback: (editor: Editor) => this.step(editor, -1),
    })

    const notes: NoteHost = {
      ask: (heading, initial, onSubmit) => new CommentModal(this.app, heading, initial, onSubmit).open(),
    }
    const layout = debounce(() => this.fitMargins(), 100, true)
    this.registerEditorExtension(critiqueEditorExtension(notes, layout))
    this.registerMarkdownPostProcessor(critiqueReadingProcessor(notes, (path, c, change) => {
      const file = this.app.vault.getFileByPath(path)
      if (file) void this.rewriteFile(file, c, change)
    }))

    const refresh = debounce(() => this.refreshViews(), 150, true)
    this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
      if (leaf?.view instanceof MarkdownView) this.target = leaf.view
      refresh()
      layout()
    }))
    this.registerEvent(this.app.workspace.on("editor-change", () => {
      refresh()
      layout()
    }))
    this.registerEvent(this.app.workspace.on("layout-change", layout))
    this.registerEvent(this.app.workspace.on("resize", layout))
    this.registerEvent(this.app.vault.on("modify", file => {
      if (file === this.target?.file) refresh()
      layout()
    }))
    this.app.workspace.onLayoutReady(() => {
      this.target = this.app.workspace.getActiveViewOfType(MarkdownView)
      this.refreshViews()
      this.fitMargins()
    })
  }

  async onunload(): Promise<void> {
    // Obsidian detaches the plugin's views and editor extensions itself.
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      leaf.view.containerEl.removeClass("critique-margin")
      leaf.view.containerEl.style.removeProperty("--critique-reserve")
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)
      await leaf?.setViewState({ type: VIEW_TYPE, active: true })
    }
    if (leaf) workspace.revealLeaf(leaf)
  }

  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof CritiqueView) leaf.view.render()
    }
  }

  /** Source text of the target view: the live editor buffer when available,
   *  otherwise the cached file contents (reading view). */
  async targetText(): Promise<{ view: MarkdownView; file: TFile; text: string } | null> {
    const view = this.target
    const file = view?.file
    if (!view || !file) return null
    const text = view.getMode() === "source" ? view.editor.getValue() : await this.app.vault.cachedRead(file)
    return { view, file, text }
  }

  addComment(editor: Editor): void {
    const quote = editor.getSelection()
    if (quote.includes("\n")) {
      new Notice("Critique comments must stay within one line")
      return
    }
    const from = editor.getCursor("from")
    const to = editor.getCursor("to")
    new CommentModal(this.app, quote ? "Comment on selection" : "Add comment", "", text => {
      editor.replaceRange(formatCritiqueComment(quote || null, text, this.settings.syntax), from, to)
    }).open()
  }

  step(editor: Editor, dir: 1 | -1): void {
    const comments = parseCritiqueComments(editor.getValue())
    const here = editor.posToOffset(editor.getCursor())
    const target = dir === 1
      ? comments.find(c => (c.highlightStart ?? c.start) > here)
      : [...comments].reverse().find(c => (c.highlightStart ?? c.start) < here)
    if (!target) {
      new Notice(dir === 1 ? "No next comment" : "No previous comment")
      return
    }
    selectComment(editor, target)
  }

  /** Focus the target note and put the selection on `c`'s highlighted text. */
  reveal(c: CritiqueComment): void {
    const view = this.target
    if (!view) return
    this.app.workspace.setActiveLeaf(view.leaf, { focus: true })
    if (view.getMode() === "source") selectComment(view.editor, c)
    else view.setEphemeralState({ line: c.line })
  }

  /** Apply a sidebar card's edit/reply/resolve to the target note. */
  async rewrite(c: CritiqueComment, change: CritiqueChange): Promise<void> {
    const t = await this.targetText()
    if (!t) return
    if (t.view.getMode() !== "source") return this.rewriteFile(t.file, c, change)
    const edit = critiqueEdit(t.text, c, change)
    if (!edit) return this.moved()
    const editor = t.view.editor
    editor.replaceRange(edit.insert, editor.offsetToPos(edit.from), editor.offsetToPos(edit.to))
  }

  async rewriteFile(file: TFile, c: CritiqueComment, change: CritiqueChange): Promise<void> {
    let found = true
    await this.app.vault.process(file, data => {
      const edit = critiqueEdit(data, c, change)
      found = edit != null
      return edit ? data.slice(0, edit.from) + edit.insert + data.slice(edit.to) : data
    })
    if (!found) this.moved()
  }

  moved(): void {
    new Notice("Comment moved; try again")
    this.refreshViews()
  }

  /** Margin notes float just right of the text column. Where the pane is too
   *  narrow for that, pad the text in by `--critique-reserve`; where even that
   *  would squeeze the text too much, drop `critique-margin` and let the notes
   *  sit inline. Files without comments are left untouched. */
  fitMargins(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view
      if (!(view instanceof MarkdownView)) continue
      const host = view.containerEl
      if (!parseCritiqueComments(view.getViewData()).length) {
        host.removeClass("critique-margin")
        host.style.removeProperty("--critique-reserve")
        continue
      }
      const box = textColumn(view)
      if (!box || !box.scroller.clientWidth) continue // hidden tab; fitted when shown
      const style = getComputedStyle(host)
      const need = (parseFloat(style.getPropertyValue("--critique-note-width")) || 220)
        + (parseFloat(style.getPropertyValue("--critique-note-gap")) || 24)
      // The reserve is padding inside a border-box block, so the block's outer
      // edge doesn't move as it changes.
      const rect = box.block.getBoundingClientRect()
      const limit = box.scroller.getBoundingClientRect().left + box.scroller.clientWidth
      const reserve = Math.max(0, Math.ceil(rect.right + need - limit))
      const fits = reserve <= rect.width * 0.4
      host.toggleClass("critique-margin", fits)
      host.style.setProperty("--critique-reserve", `${fits ? reserve : 0}px`)
    }
  }
}

/** A text block whose right edge the margin notes float against (themes like
 *  Minimal size each line rather than the container), and the scroller they
 *  have to fit inside, for whichever mode is showing. */
function textColumn(view: MarkdownView): { block: HTMLElement; scroller: HTMLElement } | null {
  let scroller: HTMLElement | null | undefined
  let blocks: HTMLElement[]
  if (view.getMode() === "preview") {
    scroller = view.previewMode.containerEl.querySelector<HTMLElement>(".markdown-preview-view")
    const sizer = scroller?.querySelector<HTMLElement>(":scope > .markdown-preview-sizer")
    blocks = sizer ? Array.from(sizer.querySelectorAll<HTMLElement>(":scope > .el-p")) : []
  } else {
    const cm = (view.editor as unknown as { cm?: { contentDOM: HTMLElement; scrollDOM: HTMLElement } }).cm
    scroller = cm?.scrollDOM
    blocks = cm ? Array.from(cm.contentDOM.querySelectorAll<HTMLElement>(":scope > .cm-line")) : []
  }
  const block = blocks.find(b => b.querySelector(".critique-note")) ?? blocks[0]
  return scroller && block ? { block, scroller } : null
}

function selectComment(editor: Editor, c: CritiqueComment): void {
  const from = editor.offsetToPos(c.highlightStart ?? c.start)
  const to = editor.offsetToPos(c.highlightEnd ?? c.end)
  editor.setSelection(from, to)
  editor.scrollIntoView({ from, to }, true)
}

class CritiqueView extends ItemView {
  private renderSeq = 0

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CritiquePlugin) {
    super(leaf)
  }

  getViewType(): string { return VIEW_TYPE }
  getDisplayText(): string { return "Comments" }
  getIcon(): string { return "message-square" }

  async onOpen(): Promise<void> {
    await this.render()
  }

  async render(): Promise<void> {
    const seq = ++this.renderSeq
    const t = await this.plugin.targetText()
    if (seq !== this.renderSeq) return
    const root = this.contentEl
    root.empty()
    root.addClass("critique-view")
    if (!t) {
      root.createDiv({ cls: "critique-empty", text: "Open a note to see its comments." })
      return
    }
    const comments = parseCritiqueComments(t.text)
    const header = root.createDiv({ cls: "critique-header" })
    header.createSpan({ cls: "critique-file", text: t.file.basename })
    header.createSpan({ cls: "critique-count", text: `${comments.length} comment${comments.length === 1 ? "" : "s"}` })
    if (!comments.length) {
      root.createDiv({ cls: "critique-empty", text: "No comments. Select text and run “Critique: Comment on selection”." })
      return
    }
    for (const c of comments) this.renderCard(root, c)
  }

  private renderCard(root: HTMLElement, c: CritiqueComment): void {
    const card = root.createDiv({ cls: "critique-card" })
    card.addEventListener("click", () => this.plugin.reveal(c))
    const meta = card.createDiv({ cls: "critique-meta" })
    meta.createSpan({ text: `Line ${c.line + 1}` })
    if (c.syntax === "critic") meta.createSpan({ cls: "critique-tag", text: "CriticMarkup" })
    if (c.quote) card.createDiv({ cls: "critique-quote", text: c.quote })
    card.createDiv({ cls: "critique-text", text: c.text || "(empty)" })
    const actions = card.createDiv({ cls: "critique-actions" })
    const edit = actions.createEl("button", { text: "Edit" })
    edit.addEventListener("click", evt => {
      evt.stopPropagation()
      new CommentModal(this.app, "Edit comment", c.text, text => void this.plugin.rewrite(c, { kind: "edit", text })).open()
    })
    const reply = actions.createEl("button", { text: "Reply" })
    reply.addEventListener("click", evt => {
      evt.stopPropagation()
      new CommentModal(this.app, "Reply", "", text => void this.plugin.rewrite(c, { kind: "reply", text })).open()
    })
    const resolve = actions.createEl("button", { text: "Resolve" })
    resolve.addEventListener("click", evt => {
      evt.stopPropagation()
      void this.plugin.rewrite(c, { kind: "resolve" })
    })
  }
}

class CommentModal extends Modal {
  constructor(app: App, private readonly heading: string, private readonly initial: string, private readonly onSubmit: (text: string) => void) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText(this.heading)
    const input = this.contentEl.createEl("textarea", { cls: "critique-input" })
    input.value = this.initial
    input.rows = 3
    const submit = () => {
      const text = input.value.trim()
      if (!text) return
      this.close()
      this.onSubmit(text)
    }
    input.addEventListener("keydown", evt => {
      if (evt.key === "Enter" && !evt.shiftKey) {
        evt.preventDefault()
        submit()
      }
    })
    new Setting(this.contentEl).addButton(b => b.setButtonText("Save").setCta().onClick(submit))
    window.setTimeout(() => input.focus(), 0)
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

class CritiqueSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: CritiquePlugin) {
    super(app, plugin)
  }

  display(): void {
    this.containerEl.empty()
    new Setting(this.containerEl)
      .setName("Comment syntax")
      .setDesc("Markup for new comments. Both are always read. Native works without any plugin: the highlight renders and the comment is hidden in reading view.")
      .addDropdown(d => d
        .addOption("obsidian", "Native: ==text==%%comment%%")
        .addOption("critic", "CriticMarkup: {==text==}{>>comment<<}")
        .setValue(this.plugin.settings.syntax)
        .onChange(async value => {
          this.plugin.settings.syntax = value === "critic" ? "critic" : "obsidian"
          await this.plugin.saveSettings()
        }))
  }
}
