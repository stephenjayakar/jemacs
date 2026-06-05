import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { app } from "electron"
import { buildDisplayModel } from "./display/build-display-model"
import { findPaneInModel } from "./display/find-pane"
import { Editor } from "./kernel/editor"
import { listWindowLeaves } from "./kernel/window"
import { installDefaultConfig, installDefaultHooks, installUserConfig, loadCustomFile } from "./config"
import { installBuiltinPlugins } from "../plugins/builtin"
import { loadStartupConfig, parseStartupArgs } from "./config/startup"
import { installDefaultModes } from "./modes/default-modes"
import { installMarkdownMode } from "./modes/markdown"
import { installLspMode } from "./lsp/install"
import { installXref } from "./xref/install"
import { runJemacsCore } from "./run-core"
import { ElectronHost } from "./ui/electron-host"

/** Headless-ish GUI smoke: opens a window briefly, exercises editor + IPC, then quits. */
async function runGuiSmokeTest(editor: Editor, host: ElectronHost): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 1500))

  const dir = await mkdtemp(join(tmpdir(), "jemacs-gui-smoke-"))
  const filePath = join(dir, "smoke-open.ts")
  await writeFile(filePath, "export const guiOpenWorks = true\n", "utf8")
  await editor.openFile(filePath)
  if (!editor.currentBuffer.text.includes("guiOpenWorks")) {
    throw new Error("openFile failed under Electron (platform I/O)")
  }

  const tsBuffer = editor.scratch("font-lock.ts", "const highlighted: number = 42\n", "typescript")
  const fontSpans = editor.fontLock(tsBuffer)
  if (!fontSpans.length) {
    throw new Error("font-lock returned no spans in Electron (tree-sitter native module?)")
  }

  editor.scratch("smoke", "before-split", "text")
  await editor.run("split-window-below")
  if (listWindowLeaves(editor.windowLayout).length < 2) {
    throw new Error("split-window-below did not create a second window")
  }

  await editor.handleKey({ name: "x", ctrl: true })
  await editor.handleKey({ name: "o", ctrl: true })
  editor.activeBuffer.insert("-verified")
  await editor.changed("gui-smoke-insert")

  const model = buildDisplayModel(editor, {
    lastMessage: "",
    viewport: host.getViewport(),
    hostLabel: "Jemacs GUI",
  })
  if (model.hostLabel !== "Jemacs GUI") throw new Error("unexpected host label")
  if (!findPaneInModel(model.windows, editor.selectedWindowId)) {
    throw new Error("display model missing selected pane")
  }
  if (!editor.activeBuffer.text.includes("verified")) {
    throw new Error("buffer insert did not apply")
  }

  await rm(dir, { recursive: true })
  console.log("GUI smoke OK: open-file, split, other-window, insert, display model")
  host.destroy()
  app.quit()
}

async function main(): Promise<void> {
  installDefaultModes()
  const editor = new Editor()
  installMarkdownMode(editor)
  const argv = process.argv
  const args = parseStartupArgs(argv)
  const evaluator = installDefaultConfig(editor)
  for (const config of args.configs) await loadStartupConfig(editor, evaluator, config)
  installLspMode(editor)
  installDefaultHooks(editor)
  installXref(editor)
  await installBuiltinPlugins(editor)
  await installUserConfig(editor, evaluator)
  await loadCustomFile(editor, evaluator)

  const file = args.files[0]
  if (file) await editor.openFile(file)

  const host = new ElectronHost()
  const binding = await runJemacsCore(editor, host)
  host.onRendererReady(() => binding.present())

  if (argv.includes("--smoke-gui")) {
    await runGuiSmokeTest(editor, host)
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
