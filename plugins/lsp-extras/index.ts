import type { Hover, MarkedString, MarkupContent, TextEdit, WorkspaceEdit } from "vscode-languageserver-types"
import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import type { LspWorkspace } from "../../src/lsp/workspace"
import {
  lspMakeHoverParams,
  lspMakeReferenceContext,
  lspMakeReferenceParams,
  lspMakeRenameParams,
  lspMakeTextDocumentIdentifier,
} from "../../src/lsp/lsp-protocol"
import { formatLocation, normalizeLocations, type ResolvedLocation } from "../../src/lsp/locations"
import { gotoResolvedLocation } from "../../src/lsp/navigation"
import { pointToPosition, positionToPoint, uriToPath } from "../../src/lsp/positions"
import { xrefPushMark } from "../../src/xref/history"
import { allClients, supportsBuffer } from "../../src/lsp/client"
import { clientInstallCmds } from "../../src/lsp/clients"
import { shadowState } from "../../src/shadow/shadow"

function activeWorkspaces(editor: Editor, buffer: BufferModel): LspWorkspace[] {
  return editor.lsp?.bufferWorkspaces(buffer).filter(w => w.status === "initialized") ?? []
}

function positionParams(workspace: LspWorkspace, buffer: BufferModel) {
  return {
    textDocument: lspMakeTextDocumentIdentifier({ uri: workspace.uriForBuffer(buffer) }),
    position: pointToPosition(buffer.text, buffer.point),
  }
}

function formatMarkup(markup: MarkedString | MarkupContent): string {
  if (typeof markup === "string") return markup
  if ("kind" in markup) return markup.value
  return "```" + markup.language + "\n" + markup.value + "\n```"
}

export function hoverInfo(contents: Hover["contents"]): string {
  const items = Array.isArray(contents) ? contents : [contents]
  return items.map(formatMarkup).filter(s => s.length).join("\n")
}

function applyTextEdits(buffer: BufferModel, edits: TextEdit[]): void {
  const sorted = [...edits].sort((a, b) => {
    const pa = positionToPoint(buffer.text, a.range.start)
    const pb = positionToPoint(buffer.text, b.range.start)
    return pb - pa
  })
  for (const edit of sorted) {
    const start = positionToPoint(buffer.text, edit.range.start)
    const end = positionToPoint(buffer.text, edit.range.end)
    buffer.replaceRange(start, end, edit.newText)
  }
}

function findBufferForPath(editor: Editor, path: string): BufferModel | undefined {
  return [...editor.buffers.values()].find(b => b.path === path)
}

export interface WorkspaceEditResult {
  edits: number
  files: number
  failed: Array<{ path: string; error: Error }>
}

export async function applyWorkspaceEdit(editor: Editor, wedit: WorkspaceEdit): Promise<WorkspaceEditResult> {
  const prepared: Array<{ path: string; edits: TextEdit[] }> = []
  if (wedit.documentChanges?.length) {
    for (const change of wedit.documentChanges) {
      if ("textDocument" in change && "edits" in change) {
        prepared.push({ path: uriToPath(change.textDocument.uri), edits: change.edits as TextEdit[] })
      }
    }
  } else if (wedit.changes) {
    for (const [uri, edits] of Object.entries(wedit.changes)) {
      prepared.push({ path: uriToPath(uri), edits })
    }
  }
  const result: WorkspaceEditResult = { edits: 0, files: 0, failed: [] }
  if (!prepared.length) return result

  const originBufferId = editor.currentBufferId
  try {
    for (const { path, edits } of prepared) {
      try {
        const buffer = findBufferForPath(editor, path) ?? await editor.openFile(path)
        applyTextEdits(buffer, edits)
        result.edits += edits.length
        result.files += 1
      } catch (err) {
        result.failed.push({ path, error: err instanceof Error ? err : new Error(String(err)) })
      }
    }
  } finally {
    if (editor.buffers.has(originBufferId) && editor.currentBufferId !== originBufferId) {
      editor.switchToBuffer(originBufferId)
    }
  }
  if (result.failed.length) {
    const total = result.files + result.failed.length
    const detail = result.failed.map(f => f.path).join(", ")
    editor.message(`Applied edits in ${result.files} of ${total} files (${result.failed.length} failed: ${detail})`)
  }
  return result
}

function locationLine(editor: Editor, loc: ResolvedLocation): string {
  const path = uriToPath(loc.uri)
  const buffer = findBufferForPath(editor, path)
  const label = formatLocation(path, loc.range)
  if (!buffer) return label
  const start = positionToPoint(buffer.text, loc.range.start)
  return `${label}: ${buffer.lineBoundsAt(start).text.trim()}`
}

async function lspHover(editor: Editor, buffer: BufferModel): Promise<void> {
  const workspaces = activeWorkspaces(editor, buffer)
  if (!workspaces.length) {
    editor.message("LSP is not active for this buffer")
    return
  }
  for (const workspace of workspaces) {
    const params = lspMakeHoverParams(positionParams(workspace, buffer))
    const result = await workspace.rpc.request("textDocument/hover", params) as Hover | null
    if (!result?.contents) continue
    const info = hoverInfo(result.contents)
    if (!info) continue
    editor.scratch("*lsp-help*", info, "markdown")
    return
  }
  editor.message("No hover info at point")
}

async function lspRename(editor: Editor, buffer: BufferModel, newName?: string): Promise<void> {
  const workspaces = activeWorkspaces(editor, buffer)
  if (!workspaces.length) {
    editor.message("LSP is not active for this buffer")
    return
  }
  const symbol = buffer.symbolBoundsAt().text || "unknown symbol"
  const name = newName ?? await editor.completingRead(`Rename \`${symbol}\` to: `, {
    history: "lsp-rename",
    initialValue: symbol,
  })
  if (!name) return
  for (const workspace of workspaces) {
    const params = lspMakeRenameParams({ ...positionParams(workspace, buffer), newName: name })
    const response = await workspace.rpc.request("textDocument/rename", params) as WorkspaceEdit | null
    if (!response) continue
    const result = await applyWorkspaceEdit(editor, response)
    if (!result.edits && !result.failed.length) continue
    if (result.failed.length) {
      const total = result.files + result.failed.length
      const detail = result.failed.map(f => f.path).join(", ")
      editor.message(`Renamed ${result.files} of ${total} files (${result.failed.length} failed: ${detail})`)
    } else {
      editor.message(`Renamed ${result.edits} occurrence${result.edits === 1 ? "" : "s"} of \`${symbol}\` to \`${name}\``)
    }
    return
  }
  editor.message("Nothing to rename")
}

/** Pick a serverId with a known installCmd — explicit `serverId` wins, else the
 *  highest-priority client matching `buffer.mode`, else prompt across all. */
export async function pickInstallableServer(editor: Editor, buffer: BufferModel, serverId?: string): Promise<string | undefined> {
  if (serverId) return clientInstallCmds[serverId] ? serverId : undefined
  const matching = allClients()
    .filter(c => supportsBuffer(c, buffer) && clientInstallCmds[c.serverId])
    .sort((a, b) => b.priority - a.priority)
  if (matching.length) return matching[0]!.serverId
  const all = Object.keys(clientInstallCmds)
  return await editor.completingRead("Install LSP server: ", { collection: all, history: "lsp-install-server" }) || undefined
}

async function lspInstallServer(editor: Editor, buffer: BufferModel, serverId?: string): Promise<void> {
  const id = await pickInstallableServer(editor, buffer, serverId)
  const cmd = id ? clientInstallCmds[id] : undefined
  if (!id || !cmd) {
    editor.message(`No install command for ${serverId ?? buffer.mode}`)
    return
  }
  // Remote buffer: the server binary needs to exist on A, not S — ship the
  // install as a Cmd op so A runs it via `compile` (DESIGN.md §Ops, S→A only).
  const state = buffer.link ? shadowState(editor) : undefined
  if (state) {
    state.link.send({ kind: "command", name: "compile", args: [cmd], seq: state.nextSeq++ })
    editor.message(`[shadow] installing ${id} on remote: ${cmd}`)
    return
  }
  await editor.run("compile", [cmd])
}

async function lspFindReferences(editor: Editor, buffer: BufferModel): Promise<void> {
  const workspaces = activeWorkspaces(editor, buffer)
  if (!workspaces.length) {
    editor.message("LSP is not active for this buffer")
    return
  }
  const collected: ResolvedLocation[] = []
  for (const workspace of workspaces) {
    const params = lspMakeReferenceParams({
      ...positionParams(workspace, buffer),
      context: lspMakeReferenceContext({ includeDeclaration: true }),
    })
    const result = await workspace.rpc.request("textDocument/references", params)
    collected.push(...normalizeLocations(result))
  }
  if (!collected.length) {
    editor.message("No references found")
    return
  }
  xrefPushMark(editor, buffer)
  if (collected.length === 1) {
    await gotoResolvedLocation(editor, collected[0]!)
    return
  }
  const labels = collected.map(loc => locationLine(editor, loc))
  editor.scratch("*xref*", labels.join("\n"), "text")
  const choice = await editor.completingRead("LSP reference: ", { collection: labels, history: "lsp-references" })
  if (!choice) return
  const index = labels.indexOf(choice)
  await gotoResolvedLocation(editor, collected[index >= 0 ? index : 0]!)
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  editor.command("lsp-hover", async ({ editor, buffer }) => {
    await lspHover(editor, buffer)
  }, "Display LSP hover documentation for the symbol at point.")

  editor.command("lsp-rename", async ({ editor, buffer, args }) => {
    await lspRename(editor, buffer, args[0])
  }, "Rename the symbol at point across the workspace via LSP.")

  editor.command("lsp-find-references", async ({ editor, buffer }) => {
    await lspFindReferences(editor, buffer)
  }, "List all LSP references to the symbol at point.")

  editor.command("lsp-install-server", async ({ editor, buffer, args }) => {
    await lspInstallServer(editor, buffer, args[0])
  }, "Install the LSP server for the current buffer's mode (runs on the remote when shadowed).")

  editor.key("C-c r", "lsp-rename")
}
