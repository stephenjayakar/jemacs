import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import { modeFeature, modeLineage } from "../../src/modes/mode"
import { defcustom, getCustom } from "../../src/runtime/custom"

export const COMPLETION_PREVIEW_LOCAL = "completion-preview-overlay"

/** Ghost-text overlay placed after point; the display layer renders `suffix` dimmed. */
export type CompletionPreviewOverlay = {
  point: number
  prefix: string
  suffix: string
  candidate: string
}

export function completionPreviewOverlay(buffer: BufferModel): CompletionPreviewOverlay | null {
  return (buffer.locals.get(COMPLETION_PREVIEW_LOCAL) as CompletionPreviewOverlay | undefined) ?? null
}

function isProgMode(modeName: string): boolean {
  return modeLineage(modeName).some(m => m.name === "prog-mode")
}

function previewHide(editor: Editor, buffer: BufferModel): void {
  if (!buffer.locals.has(COMPLETION_PREVIEW_LOCAL)) return
  buffer.locals.delete(COMPLETION_PREVIEW_LOCAL)
  if (buffer.minorModes.has("completion-preview-active-mode")) {
    editor.disableMinorMode("completion-preview-active-mode", { buffer })
  }
}

function previewShow(editor: Editor, buffer: BufferModel): void {
  if (!editor.isMinorModeEnabled("completion-preview-mode", buffer)) return
  if (!isProgMode(buffer.mode)) return previewHide(editor, buffer)

  const symbol = buffer.symbolBoundsAt()
  if (symbol.end !== buffer.point) return previewHide(editor, buffer)
  const prefix = buffer.text.slice(symbol.start, buffer.point)
  const min = getCustom<number>("completion-preview-minimum-symbol-length") ?? 3
  if (prefix.length < min) return previewHide(editor, buffer)

  const capf = modeFeature(buffer.mode, "completeAtPoint")
  const raw = capf?.(buffer) ?? []
  if (!raw.length) return previewHide(editor, buffer)

  const texts = raw.map(c => c.text)
  const ranked = editor.completer ? editor.completer(prefix, texts) : texts
  const top = ranked[0]
  if (!top || !top.startsWith(prefix) || top === prefix) return previewHide(editor, buffer)

  const overlay: CompletionPreviewOverlay = {
    point: buffer.point,
    prefix,
    suffix: top.slice(prefix.length),
    candidate: top,
  }
  buffer.locals.set(COMPLETION_PREVIEW_LOCAL, overlay)
  if (!buffer.minorModes.has("completion-preview-active-mode")) {
    editor.enableMinorMode("completion-preview-active-mode", { buffer })
  }
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defcustom("completion-preview-minimum-symbol-length", "number", 3,
    "Minimum length of the symbol at point before showing a preview.")

  ctx.minorMode({
    name: "completion-preview-mode",
    lighter: " CP",
    global: true,
    onDisable: ed => {
      for (const buf of ed.buffers.values()) previewHide(ed, buf)
    },
  })

  const active = ctx.minorMode({
    name: "completion-preview-active-mode",
    lighter: "",
  })
  active.keymap?.bind("tab", "completion-preview-insert")
  active.keymap?.bind("C-i", "completion-preview-insert")

  editor.command("completion-preview-mode", ({ editor, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument > 0) editor.enableMinorMode("completion-preview-mode")
    else if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode("completion-preview-mode")
    else editor.toggleMinorMode("completion-preview-mode")
  }, "Toggle inline ghost-text completion preview after self-insert.")

  editor.command("completion-preview-insert", ({ editor, buffer }) => {
    const overlay = completionPreviewOverlay(buffer)
    if (!overlay || buffer.point !== overlay.point) {
      previewHide(editor, buffer)
      return editor.run("indent-for-tab-command")
    }
    buffer.insert(overlay.suffix)
    previewHide(editor, buffer)
  }, "Accept the current completion preview, inserting the suggested suffix.")

  ctx.advice("self-insert-command", {
    after: ({ editor, buffer }) => previewShow(editor, buffer),
  })

  editor.events.on("changed", ({ reason }) => {
    if (!reason.startsWith("command:")) return
    if (reason === "command:self-insert-command") return
    if (reason.startsWith("command:completion-preview-")) return
    previewHide(editor, editor.currentBuffer)
  })
}
