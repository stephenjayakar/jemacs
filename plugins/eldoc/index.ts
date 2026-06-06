import type { Hover } from "vscode-languageserver-types"
import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import type { LspWorkspace } from "../../src/lsp/workspace"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { modeLineage } from "../../src/modes/mode"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { lspMakeHoverParams, lspMakeTextDocumentIdentifier } from "../../src/lsp/lsp-protocol"
import { pointToPosition } from "../../src/lsp/positions"
import { hoverInfo } from "../lsp-extras"
import { cancelTimer, runWithIdleTimer, type Timer } from "../persist"

export type EldocFunction = (buffer: BufferModel) => string | null | undefined | Promise<string | null | undefined>

const ELDOC_LAST_MESSAGE = "eldoc-last-message"

// Echo area is editor-global, so the dedup key must be too — buffer-local
// `last` lets a stale message from another buffer survive a switch (t-8d4811ae).
const lastEchoed = new WeakMap<Editor, string>()

export function firstLine(s: string): string {
  for (const line of s.split("\n")) {
    const t = line.trim()
    if (t && !t.startsWith("```")) return t
  }
  return ""
}

function eldocEnabled(editor: Editor, buffer: BufferModel): boolean {
  return editor.isMinorModeEnabled("eldoc-mode", buffer)
    || editor.isMinorModeEnabled("global-eldoc-mode", buffer)
}

export function modeEldocFunction(buffer: BufferModel): EldocFunction | undefined {
  for (const mode of modeLineage(buffer.mode)) {
    const fn = (mode as { eldocFunction?: EldocFunction }).eldocFunction
    if (fn) return fn
  }
  return undefined
}

async function lspEldoc(editor: Editor, buffer: BufferModel): Promise<string | null> {
  const workspaces: LspWorkspace[] = editor.lsp?.bufferWorkspaces(buffer)
    .filter(w => w.status === "initialized") ?? []
  for (const ws of workspaces) {
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

export async function eldocPrintCurrentSymbolInfo(editor: Editor): Promise<string | null> {
  if (editor.minibuffer || editor.isearch) return null
  const buffer = editor.currentBuffer
  if (!eldocEnabled(editor, buffer)) return null

  let doc = await lspEldoc(editor, buffer)
  if (!doc) {
    const fn = modeEldocFunction(buffer)
    if (fn) doc = (await fn(buffer)) ?? null
  }
  // Drop the result if the user moved on while we were awaiting LSP.
  if (editor.currentBuffer !== buffer) return null

  const line = doc ? firstLine(doc) : null
  const shown = lastEchoed.get(editor)
  if (line) {
    buffer.locals.set(ELDOC_LAST_MESSAGE, line)
    if (line !== shown) {
      lastEchoed.set(editor, line)
      editor.message(line)
    }
  } else {
    buffer.locals.delete(ELDOC_LAST_MESSAGE)
    if (shown !== undefined) {
      lastEchoed.delete(editor)
      editor.message("")
    }
  }
  return line
}

const idleTimers = new WeakMap<Editor, Timer>()

export function eldocScheduleTimer(editor: Editor): Timer {
  const prev = idleTimers.get(editor)
  if (prev) cancelTimer(prev)
  const secs = getCustom<number>("eldoc-idle-delay") ?? 0.3
  const timer = runWithIdleTimer(secs, true, () => void eldocPrintCurrentSymbolInfo(editor))
  idleTimers.set(editor, timer)
  return timer
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defcustom("eldoc-idle-delay", "number", 0.3,
    "Seconds of idle time before ElDoc shows documentation in the echo area.")

  ctx.minorMode({
    name: "eldoc-mode",
    lighter: " ElDoc",
    onDisable: (_ed, buffer) => buffer?.locals.delete(ELDOC_LAST_MESSAGE),
  })
  ctx.minorMode({ name: "global-eldoc-mode", lighter: "", global: true })

  editor.command("eldoc-mode", ({ editor, buffer, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument > 0) editor.enableMinorMode("eldoc-mode", { buffer })
    else if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode("eldoc-mode", { buffer })
    else editor.toggleMinorMode("eldoc-mode", { buffer })
  }, "Toggle echo-area display of documentation for the thing at point.")

  editor.command("global-eldoc-mode", ({ editor, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument > 0) editor.enableMinorMode("global-eldoc-mode")
    else if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode("global-eldoc-mode")
    else editor.toggleMinorMode("global-eldoc-mode")
  }, "Toggle Global Eldoc mode in all buffers.")

  editor.command("eldoc", async ({ editor }) => {
    const buffer = editor.currentBuffer
    buffer.locals.delete(ELDOC_LAST_MESSAGE)
    lastEchoed.delete(editor)
    const line = await eldocPrintCurrentSymbolInfo(editor)
    if (!line) editor.message("No documentation at point")
  }, "Show documentation for the thing at point in the echo area now.")

  editor.enableMinorMode("global-eldoc-mode")
  eldocScheduleTimer(editor)
  ctx.onDispose(() => {
    const t = idleTimers.get(editor)
    if (t) cancelTimer(t)
    idleTimers.delete(editor)
  })
}
