import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { createPluginContext } from "../../src/runtime/plugin-context"
import { LspManager } from "../../src/lsp/manager"
import { allClients, registerClient } from "../../src/lsp/client"
import {
  install,
  registerCapability,
  unregisterCapability,
  watchState,
  type WatchmanRunner,
} from "../../plugins/lsp-watchman"
import type { LspWorkspace } from "../../src/lsp/workspace"

function fakeWorkspace(root: string): LspWorkspace {
  return {
    root,
    client: {
      serverId: "fake", majorModes: [], priority: 0, languageId: () => "x",
      newConnection: { connect: () => ({ send: () => {}, proc: { kill: () => {} } }) },
    },
    status: "initialized",
    buffers: [],
    openedUris: new Set(),
    serverCapabilities: null,
    diagnosticsByPath: new Map(),
    rpc: { sendNotification: () => {}, request: async () => null, requestAsync: () => 0, dispose: () => {} },
    send: () => {},
    kill: () => {},
    uriForBuffer: () => "",
  }
}

const noopRunner: WatchmanRunner = async () => ({ files: [] })

// t-audit-66bc6157: module-global `state` was a Map<LspWorkspace,_> (strong refs)
// and registerCapability's setInterval was never torn down on plugin dispose.
// Hot-reloading the plugin leaked both the workspace and a live poll timer.
test("lsp-watchman: ctx.dispose() clears poll timers and per-workspace state", () => {
  const editor = makeEditor()
  editor.lsp = new LspManager(editor)
  const ctx = createPluginContext(editor)
  install(editor, ctx)

  const ws = fakeWorkspace("/repo")
  editor.lsp.workspaces.push(ws)
  registerCapability(editor, ws, "watch", [{ globPattern: "**/*.rs" }], noopRunner)
  expect(watchState(ws)?.timer).toBeTruthy()

  ctx.dispose()
  const stateAfter = watchState(ws)
  unregisterCapability(ws) // belt-and-braces cleanup while the bug stands
  expect(stateAfter).toBeUndefined()
})

// merged t-audit-984f60be: install() built onRegister/onUnregister closures that
// captured the install-time `editor` and wrote them into the process-global
// client registry; a second editor's install overwrote the first, so capability
// registrations for editor A's workspaces routed editor.message() to editor B.
test("lsp-watchman: request handler routes to the workspace's owning editor", () => {
  registerClient({
    serverId: "watchman-route-client",
    majorModes: ["rust"], priority: 0, languageId: () => "rust",
    newConnection: { connect: () => ({ send: () => {}, proc: { kill: () => {} } }) },
  })

  const a = makeEditor(); a.lsp = new LspManager(a)
  const b = makeEditor(); b.lsp = new LspManager(b)
  const aMsgs: string[] = []; a.events.on("message", (e: { text: string }) => { aMsgs.push(e.text) })
  const bMsgs: string[] = []; b.events.on("message", (e: { text: string }) => { bMsgs.push(e.text) })

  const ctxA = createPluginContext(a)
  const ctxB = createPluginContext(b)
  install(a, ctxA)
  install(b, ctxB)

  const ws = fakeWorkspace("/a-repo")
  a.lsp.workspaces.push(ws)

  const client = allClients().find(c => c.serverId === "watchman-route-client")!
  const handler = client.requestHandlers!.get("client/registerCapability")!
  handler(ws, { registrations: [{ id: "r", method: "workspace/didChangeWatchedFiles",
    registerOptions: { watchers: [{ globPattern: "**/*.rs" }] } }] })

  const aHit = aMsgs.some(m => m.includes("/a-repo"))
  const bHit = bMsgs.some(m => m.includes("/a-repo"))
  unregisterCapability(ws)
  ctxA.dispose(); ctxB.dispose()

  expect(aHit).toBe(true)
  expect(bHit).toBe(false)
})
