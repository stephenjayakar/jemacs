import type { Hover } from "vscode-languageserver-types"
import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import type { LspWorkspace } from "../../src/lsp/workspace"
import { BufferModel as BufferModelCtor } from "../../src/kernel/buffer"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { lspMakeHoverParams, lspMakeTextDocumentIdentifier } from "../../src/lsp/lsp-protocol"
import { pointToPosition } from "../../src/lsp/positions"
import { hoverInfo } from "../lsp-extras"
import { cancelTimer, runWithIdleTimer, type Timer } from "../persist"

const DOC_BUFFER = "*lsp-ui-doc*"
const frameIds = new WeakMap<Editor, string>()
const idleTimers = new WeakMap<Editor, Timer>()
const lastDocs = new WeakMap<Editor, string>()

function activeWorkspaces(editor: Editor, buffer: BufferModel): LspWorkspace[] {
  return editor.lsp?.bufferWorkspaces(buffer).filter(w => w.status === "initialized") ?? []
}

function enabled(editor: Editor, buffer: BufferModel): boolean {
  return getCustom<boolean>("lsp-ui-doc-enable") === true
    || editor.isMinorModeEnabled("lsp-ui-doc-mode", buffer)
}

async function lspHoverDoc(editor: Editor, buffer: BufferModel): Promise<string | null> {
  for (const ws of activeWorkspaces(editor, buffer)) {
    const params = lspMakeHoverParams({
      textDocument: lspMakeTextDocumentIdentifier({ uri: ws.uriForBuffer(buffer) }),
      position: pointToPosition(buffer.text, buffer.point),
    })
    try {
      const result = await ws.rpc.request("textDocument/hover", params) as Hover | null
      if (!result?.contents) continue
      const info = hoverInfo(result.contents)
      if (info) return info
    } catch {
      continue
    }
  }
  return null
}

function docBuffer(editor: Editor, text: string): BufferModel {
  const existing = [...editor.buffers.values()].find(b => b.name === DOC_BUFFER)
  if (existing) {
    existing.setText(text, false)
    existing.kind = "scratch"
    editor.enterMode(existing, "markdown")
    return existing
  }
  const buffer = new BufferModelCtor({ name: DOC_BUFFER, text, kind: "scratch", mode: "markdown" })
  editor.addBuffer(buffer)
  editor.enterMode(buffer, "markdown")
  return buffer
}

export function lspUiDocHide(editor: Editor): void {
  const id = frameIds.get(editor)
  const frame = id ? editor.childFrames.get(id) : undefined
  if (frame) frame.visible = false
  frameIds.delete(editor)
  lastDocs.delete(editor)
  void editor.changed("lsp-ui-doc-hide")
}

export async function lspUiDocShow(editor: Editor, options: { force?: boolean } = {}): Promise<string | null> {
  if (editor.minibuffer || editor.isearch) return null
  const origin = editor.currentBuffer
  if (!options.force && !enabled(editor, origin)) return null
  const doc = await lspHoverDoc(editor, origin)
  if (editor.currentBuffer !== origin) return null
  if (!doc) {
    lspUiDocHide(editor)
    return null
  }
  if (lastDocs.get(editor) === doc) return doc
  const buffer = docBuffer(editor, doc)
  const frame = editor.displayBufferInChildFrame(buffer.id, {
    childFrameParameters: {
      width: getCustom<number>("lsp-ui-doc-max-width") ?? 72,
      height: getCustom<number>("lsp-ui-doc-max-height") ?? 12,
    },
  })
  frameIds.set(editor, frame.id)
  lastDocs.set(editor, doc)
  return doc
}

function schedule(editor: Editor): Timer {
  const prev = idleTimers.get(editor)
  if (prev) cancelTimer(prev)
  const secs = getCustom<number>("lsp-ui-doc-delay") ?? 0.3
  const timer = runWithIdleTimer(secs, true, () => void lspUiDocShow(editor))
  idleTimers.set(editor, timer)
  return timer
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defcustom("lsp-ui-doc-enable", "boolean", false,
    "If non-nil, show LSP hover documentation in a child frame.", "tools")
  defcustom("lsp-ui-doc-delay", "number", 0.3,
    "Seconds of idle time before lsp-ui-doc requests hover documentation.", "tools")
  defcustom("lsp-ui-doc-max-width", "integer", 72,
    "Maximum child-frame width for lsp-ui-doc, in character cells.", "tools")
  defcustom("lsp-ui-doc-max-height", "integer", 12,
    "Maximum child-frame height for lsp-ui-doc, in character cells.", "tools")

  ctx.minorMode({
    name: "lsp-ui-doc-mode",
    lighter: " LspDoc",
    onDisable: ed => lspUiDocHide(ed),
  })

  editor.command("lsp-ui-doc-mode", ({ editor, buffer, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument > 0) editor.enableMinorMode("lsp-ui-doc-mode", { buffer })
    else if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode("lsp-ui-doc-mode", { buffer })
    else editor.toggleMinorMode("lsp-ui-doc-mode", { buffer })
  }, "Toggle LSP hover documentation in a child frame.")

  editor.command("lsp-ui-doc-show", async ({ editor }) => {
    const doc = await lspUiDocShow(editor, { force: true })
    if (!doc) editor.message("No documentation at point")
  }, "Show LSP hover documentation at point in a child frame.")

  editor.command("lsp-ui-doc-hide", ({ editor }) => {
    lspUiDocHide(editor)
  }, "Hide the lsp-ui-doc child frame.")

  editor.command("lsp-ui-doc-toggle", async ({ editor }) => {
    const id = frameIds.get(editor)
    const visible = id ? editor.childFrames.get(id)?.visible : false
    if (visible) lspUiDocHide(editor)
    else await lspUiDocShow(editor, { force: true })
  }, "Toggle the lsp-ui-doc child frame.")

  schedule(editor)
  ctx.onDispose(() => {
    const timer = idleTimers.get(editor)
    if (timer) cancelTimer(timer)
    idleTimers.delete(editor)
    lspUiDocHide(editor)
  })
}
