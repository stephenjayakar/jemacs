import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { createPluginContext } from "../../src/runtime/plugin-context"
import { LspManager } from "../../src/lsp/manager"
import { allClients, registerClient } from "../../src/lsp/client"
import { install, unregisterCapability, watchState } from "../../plugins/lsp-watchman"
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

// t-audit-984f60be: install() built onRegister/onUnregister as closures over the
// install-time `editor` and wrote them into the process-global LspClient
// registry. A second editor's install() overwrote the first's handlers, so a
// client/registerCapability for editor A's workspace would call editor.message()
// (and start a poll loop bound to) editor B. Fix: module-level handlers resolve
// the owning editor at call time via the `installed` set + ownerOf(workspace).
test("lsp-watchman: second install() does not hijack first editor's handler", () => {
  registerClient({
    serverId: "watchman-984f60be",
    majorModes: ["rust"], priority: 0, languageId: () => "rust",
    newConnection: { connect: () => ({ send: () => {}, proc: { kill: () => {} } }) },
  })

  const a = makeEditor(); a.lsp = new LspManager(a)
  const b = makeEditor(); b.lsp = new LspManager(b)
  const aMsgs: string[] = []; a.events.on("message", (e: { text: string }) => { aMsgs.push(e.text) })
  const bMsgs: string[] = []; b.events.on("message", (e: { text: string }) => { bMsgs.push(e.text) })

  const ctxA = createPluginContext(a); install(a, ctxA)
  const ctxB = createPluginContext(b); install(b, ctxB) // would overwrite A's handler pre-fix

  const wsA = fakeWorkspace("/a-repo"); a.lsp.workspaces.push(wsA)
  const wsB = fakeWorkspace("/b-repo"); b.lsp.workspaces.push(wsB)

  const client = allClients().find(c => c.serverId === "watchman-984f60be")!
  const onRegister = client.requestHandlers!.get("client/registerCapability")!
  const params = (id: string) => ({ registrations: [{ id, method: "workspace/didChangeWatchedFiles",
    registerOptions: { watchers: [{ globPattern: "**/*.rs" }] } }] })

  onRegister(wsA, params("ra"))
  onRegister(wsB, params("rb"))

  const aSawA = aMsgs.some(m => m.includes("/a-repo"))
  const aSawB = aMsgs.some(m => m.includes("/b-repo"))
  const bSawA = bMsgs.some(m => m.includes("/a-repo"))
  const bSawB = bMsgs.some(m => m.includes("/b-repo"))
  // both workspaces got watch state regardless of which editor installed last
  const stateA = watchState(wsA)
  const stateB = watchState(wsB)

  unregisterCapability(wsA); unregisterCapability(wsB)
  ctxA.dispose(); ctxB.dispose()

  expect(stateA).toBeDefined()
  expect(stateB).toBeDefined()
  expect(aSawA).toBe(true)
  expect(bSawB).toBe(true)
  // the actual bug: A's workspace must not route to B (or vice versa)
  expect(bSawA).toBe(false)
  expect(aSawB).toBe(false)
})

// Disposing one editor's plugin context must not strip the (shared, module-level)
// handler out from under the other editor.
test("lsp-watchman: disposing one editor leaves the other's handler functional", () => {
  registerClient({
    serverId: "watchman-984f60be-dispose",
    majorModes: ["rust"], priority: 0, languageId: () => "rust",
    newConnection: { connect: () => ({ send: () => {}, proc: { kill: () => {} } }) },
  })

  const a = makeEditor(); a.lsp = new LspManager(a)
  const b = makeEditor(); b.lsp = new LspManager(b)
  const bMsgs: string[] = []; b.events.on("message", (e: { text: string }) => { bMsgs.push(e.text) })

  const ctxA = createPluginContext(a); install(a, ctxA)
  const ctxB = createPluginContext(b); install(b, ctxB)
  ctxA.dispose() // A goes away; B should still work

  const wsB = fakeWorkspace("/b-repo"); b.lsp.workspaces.push(wsB)
  const client = allClients().find(c => c.serverId === "watchman-984f60be-dispose")!
  const onRegister = client.requestHandlers!.get("client/registerCapability")!
  onRegister(wsB, { registrations: [{ id: "r", method: "workspace/didChangeWatchedFiles",
    registerOptions: { watchers: [{ globPattern: "**/*.rs" }] } }] })

  const stateB = watchState(wsB)
  const bSawB = bMsgs.some(m => m.includes("/b-repo"))
  unregisterCapability(wsB); ctxB.dispose()

  expect(onRegister).toBeInstanceOf(Function)
  expect(stateB).toBeDefined()
  expect(bSawB).toBe(true)
})
