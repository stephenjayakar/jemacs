import type { LspWorkspace } from "./workspace"

/** Mirrors `cl-defstruct lsp-session` in lsp-mode.el. */
export type LspSession = {
  folders: string[]
  folderToServers: Map<string, LspWorkspace[]>
  serverIdToFolders: Map<string, string[]>
}

export function createSession(): LspSession {
  return {
    folders: [],
    folderToServers: new Map(),
    serverIdToFolders: new Map(),
  }
}

export function findSessionFolder(session: LspSession, filePath: string): string | undefined {
  const canonical = filePath
  return session.folders.find(folder => canonical.startsWith(folder.endsWith("/") ? folder : `${folder}/`) || canonical === folder)
}

export function linkFolderToWorkspace(session: LspSession, folder: string, workspace: LspWorkspace): void {
  const list = session.folderToServers.get(folder) ?? []
  if (!list.includes(workspace)) list.push(workspace)
  session.folderToServers.set(folder, list)
  if (!session.folders.includes(folder)) session.folders.push(folder)
}
