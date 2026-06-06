import { expect, test } from "bun:test"
import { writeFile, mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { script } from "../harness"
import { Evaluator } from "../../src/runtime/evaluator"
import { getHooks } from "../../src/kernel/hooks"

test("loadPlugin accepts absolute paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-hot-"))
  const file = join(dir, "p.ts")
  await writeFile(file, `export function install(e) { e.command("hot-abs-test", () => e.message("ok")) }`)
  const editor = await script().done()
  const ev = new Evaluator(editor)
  await ev.loadPlugin(file)
  expect(editor.commands.get("hot-abs-test")).toBeDefined()
})

test.skipIf(!!process.env.CI)("loadPlugin reload picks up edits (cache-bust)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-hot-"))
  const file = join(dir, "p.ts")
  const tpl = (v: string) => `export function install(e) { e.command("hot-ver", () => e.message("${v}")) }`
  await writeFile(file, tpl("v1"))
  const editor = await script().done()
  const ev = new Evaluator(editor)
  let msg = ""; editor.events.on("message", ({ text }) => { msg = text })
  await ev.loadPlugin(file)
  await editor.run("hot-ver"); expect(msg).toContain("v1")
  await writeFile(file, tpl("v2"))
  await ev.loadPlugin(file)
  await editor.run("hot-ver"); expect(msg).toContain("v2")
})

test("reload does not accumulate hooks (PluginContext dispose)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-hot-"))
  const file = join(dir, "p.ts")
  await writeFile(file, `export function install(e, ctx) { ctx.hook("hot-reload-hook", () => e.message("ran")) }`)
  const editor = await script({ plugins: false }).done()
  const ev = new Evaluator(editor)
  let n = 0; editor.events.on("message", () => { n++ })
  await ev.loadPlugin(file)
  await ev.loadPlugin(file) // reload: old ctx disposed before re-install
  expect(getHooks("hot-reload-hook").length).toBe(1)
  await editor.runHook("hot-reload-hook", editor.currentBuffer)
  expect(n).toBe(1)
})

test("fido-ret with absolute input returns the input, not candidate (unit level — concat seen at layer 3 is in load-plugin's resolveModule)", async () => {
  // fido RET on a file-completion prompt should accept the typed absolute path,
  // not concatenate it with the selected candidate.
  const editor = await script().done()
  let resolved: string | null = null
  editor.command("probe-prompt", async () => {
    resolved = await editor.completingRead("Load: ", {
      collection: ["plugins/demo-plugin.ts"],
      initialValue: "",
    })
  })
  const p = editor.run("probe-prompt")
  // type an absolute path then accept literally (fido-ret now refuses on no-match)
  editor.activeBuffer.setText("/tmp/x.ts", false)
  editor.activeBuffer.point = "/tmp/x.ts".length
  await editor.run("icomplete-fido-exit")
  await p
  expect(resolved).toBe("/tmp/x.ts")
})
