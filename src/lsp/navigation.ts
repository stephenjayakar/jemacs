import type { Editor } from "../kernel/editor"
import type { BufferModel } from "../kernel/buffer"
import { xrefPushMark } from "../xref/history"
import { allClients, serverBinaryPresent, supportsBuffer } from "./client"
import {
  lspMakeDefinitionParams,
  lspMakeImplementationParams,
  lspMakeTextDocumentIdentifier,
} from "./lsp-protocol"
import { formatLocation, normalizeLocations, type ResolvedLocation } from "./locations"
import { pointToPosition, positionToPoint, uriToPath } from "./positions"
import type { LspWorkspace } from "./workspace"

async function ensureLspWorkspaces(editor: Editor, buffer: BufferModel): Promise<LspWorkspace[]> {
  if (!editor.lsp) return []
  let workspaces = editor.lsp.bufferWorkspaces(buffer).filter(w => w.status === "initialized")
  if (workspaces.length) return workspaces
  await editor.lsp.lsp(buffer)
  workspaces = editor.lsp.bufferWorkspaces(buffer).filter(w => w.status === "initialized")
  return workspaces
}

async function pickLocation(editor: Editor, locations: ResolvedLocation[]): Promise<ResolvedLocation | null> {
  if (!locations.length) return null
  if (locations.length === 1) return locations[0]!
  const labels = locations.map(loc => formatLocation(uriToPath(loc.uri), loc.range))
  const choice = await editor.completingRead("LSP location: ", { collection: labels })
  if (!choice) return null
  const index = labels.indexOf(choice)
  return locations[index >= 0 ? index : 0]!
}

export async function gotoResolvedLocation(editor: Editor, location: ResolvedLocation): Promise<void> {
  const path = uriToPath(location.uri)
  const buffer = await editor.openFile(path)
  buffer.point = positionToPoint(buffer.text, location.range.start)
  await editor.changed("lsp-goto")
}

/** True when an LSP client can serve definitions for this buffer (binary on PATH or Emacs cache). */
export function lspDefinitionAvailable(editor: Editor, buffer: BufferModel): boolean {
  if (!editor.lsp || !buffer.path) return false
  if (editor.lsp.bufferWorkspaces(buffer).some(w => w.status === "initialized")) return true
  return allClients()
    .some(client => supportsBuffer(client, buffer) && serverBinaryPresent(client, buffer))
}

export async function lspFindDefinition(editor: Editor, buffer: BufferModel): Promise<boolean> {
  const workspaces = await ensureLspWorkspaces(editor, buffer)
  if (!workspaces.length) {
    editor.message("LSP is not active for this buffer")
    return false
  }

  for (const workspace of workspaces) {
    try {
      const params = lspMakeDefinitionParams({
        textDocument: lspMakeTextDocumentIdentifier({ uri: workspace.uriForBuffer(buffer) }),
        position: pointToPosition(buffer.text, buffer.point),
      })
      const result = await workspace.rpc.request("textDocument/definition", params)
      const locations = normalizeLocations(result)
      if (!locations.length) continue

      xrefPushMark(editor, buffer)
      const location = await pickLocation(editor, locations)
      if (!location) return false
      await gotoResolvedLocation(editor, location)
      editor.message("Found definition (LSP)")
      return true
    } catch {
      continue
    }
  }

  editor.message("No definition found (LSP)")
  return false
}

export async function lspFindImplementation(editor: Editor, buffer: BufferModel): Promise<void> {
  const workspaces = await ensureLspWorkspaces(editor, buffer)
  if (!workspaces.length) {
    editor.message("LSP is not active for this buffer")
    return
  }
  for (const workspace of workspaces) {
    try {
      const params = lspMakeImplementationParams({
        textDocument: lspMakeTextDocumentIdentifier({ uri: workspace.uriForBuffer(buffer) }),
        position: pointToPosition(buffer.text, buffer.point),
      })
      const result = await workspace.rpc.request("textDocument/implementation", params)
      const locations = normalizeLocations(result)
      if (!locations.length) continue
      const location = await pickLocation(editor, locations)
      if (location) {
        await gotoResolvedLocation(editor, location)
        return
      }
      return
    } catch {
      continue
    }
  }
  editor.message("No implementation found")
}
