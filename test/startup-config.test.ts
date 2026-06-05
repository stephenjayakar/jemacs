import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig } from "../src/config"
import { loadStartupConfig, parseStartupArgs } from "../src/config/startup"

test("parseStartupArgs collects config flags and file args", () => {
  const args = parseStartupArgs(["bun", "src/main.ts", "--config", "./local.ts", "--gui", "--config=./other.ts", "README.md"])
  expect(args.configs).toEqual(["./local.ts", "./other.ts"])
  expect(args.files).toEqual(["README.md"])
})

test("loadStartupConfig loads the Stephen config fixture", async () => {
  const editor = new Editor()
  const evaluator = installDefaultConfig(editor)
  expect(editor.keymap.get("s-f")).toBeUndefined()

  const fixture = join(import.meta.dir, "fixtures/stephen-config.ts")
  await loadStartupConfig(editor, evaluator, fixture)

  expect(editor.keymap.get("s-f")).toBe("counsel-ag")
  expect(editor.isMinorModeEnabled("linum-mode")).toBe(true)
})

test("loadStartupConfig loads a TypeScript config module", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-startup-config-"))
  try {
    const config = join(dir, "config.ts")
    await writeFile(config, `export function install(editor: any) { editor.command("test-config-command", ({ editor }: any) => editor.message("loaded config")) }\n`)

    const editor = new Editor()
    const evaluator = installDefaultConfig(editor)
    await loadStartupConfig(editor, evaluator, config)

    await editor.run("test-config-command")
    expect([...editor.buffers.values()].find(b => b.name === "*messages*")?.text).toContain("loaded config")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
