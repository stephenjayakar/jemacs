import { expect, test } from "bun:test"
import { makeEditor } from "./helper"
import { install, pickInstallableServer } from "../../plugins/lsp-extras"
import { BufferModel } from "../../src/kernel/buffer"
import { clientInstallCmds, registerAllLspClients } from "../../src/lsp/clients"
import { attachShadow, shadowState, type ShadowLink, type ShadowOp } from "../../src/shadow/shadow"

function queuedLink() {
  const sent: ShadowOp[] = []
  const link: ShadowLink = {
    peerId: "A", role: "shadow", trust: "full",
    send: op => sent.push(op),
    on: () => {},
    close: () => {},
  }
  return { link, sent }
}

test("clientInstallCmds covers every registered client", () => {
  expect(clientInstallCmds.gopls).toContain("go install")
  expect(clientInstallCmds["rust-analyzer"]).toContain("rustup")
  expect(clientInstallCmds["typescript-language-server"]).toContain("npm install")
  expect(Object.keys(clientInstallCmds).sort()).toEqual(
    ["gopls", "lean", "pylsp", "rust-analyzer", "typescript-language-server", "yaml-language-server"],
  )
})

test("pickInstallableServer: explicit id, mode match, then prompt", async () => {
  registerAllLspClients()
  const editor = makeEditor()
  const goBuf = new BufferModel({ name: "a.go", text: "", mode: "go" })
  expect(await pickInstallableServer(editor, goBuf, "pylsp")).toBe("pylsp")
  expect(await pickInstallableServer(editor, goBuf, "no-such")).toBeUndefined()
  expect(await pickInstallableServer(editor, goBuf)).toBe("gopls")
})

test("lsp-install-server runs compile locally for a non-linked buffer", async () => {
  registerAllLspClients()
  const editor = makeEditor()
  install(editor)
  const buf = editor.addBuffer(new BufferModel({ name: "a.go", path: "/p/a.go", text: "package main\n", mode: "go" }))
  editor.switchToBuffer(buf.id)

  const compiled: string[] = []
  editor.command("compile", async ({ args }) => { compiled.push(args[0]!) }, "stub")

  await editor.run("lsp-install-server")
  expect(compiled).toEqual([clientInstallCmds.gopls])
})

test("lsp-install-server ships a Cmd op when buffer.link is set", async () => {
  registerAllLspClients()
  const editor = makeEditor()
  install(editor)
  const buf = editor.addBuffer(new BufferModel({ id: "b1", name: "lib.rs", path: "/p/lib.rs", text: "fn main(){}\n", mode: "rust" }))
  editor.switchToBuffer(buf.id)

  const { link, sent } = queuedLink()
  attachShadow(editor, link)
  expect(buf.link).toBe(link)

  let localCompile = 0
  editor.command("compile", async () => { localCompile++ }, "stub")

  await editor.run("lsp-install-server")

  expect(localCompile).toBe(0)
  const cmd = sent.find(op => op.kind === "command") as Extract<ShadowOp, { kind: "command" }>
  expect(cmd).toBeDefined()
  expect(cmd.name).toBe("compile")
  expect(cmd.args).toEqual([clientInstallCmds["rust-analyzer"]])
  expect(cmd.seq).toBe(1)

  // Second call advances the shared seq counter so A's in-order buffer accepts it.
  await editor.run("lsp-install-server", ["pylsp"])
  const cmds = sent.filter(op => op.kind === "command") as Array<Extract<ShadowOp, { kind: "command" }>>
  expect(cmds[1]!.seq).toBe(2)
  expect(shadowState(editor)!.nextSeq).toBe(3)
})

test("lsp-install-server messages when no install command exists", async () => {
  const editor = makeEditor()
  install(editor)
  const buf = editor.addBuffer(new BufferModel({ name: "x", text: "", mode: "text" }))
  editor.switchToBuffer(buf.id)
  let msg = ""
  editor.events.on("message", e => { msg = e.text })
  await editor.run("lsp-install-server", ["no-such"])
  expect(msg).toBe("No install command for no-such")
})
