import { Editor } from "./kernel/editor"
import { installDefaultConfig, installDefaultHooks, installUserConfig, loadCustomFile } from "./config"
import { loadStartupConfig, parseStartupArgs } from "./config/startup"
import { installDefaultModes } from "./modes/default-modes"
import { installMarkdownMode } from "./modes/markdown"
import { installLspMode } from "./lsp/install"
import { installXref } from "./xref/install"
import { runJemacs } from "./run"
import { createDefaultHost } from "./ui/select-host"
import { installBuiltinPlugins } from "../plugins/builtin"

async function main(): Promise<void> {
  installDefaultModes()
  const editor = new Editor()
  installMarkdownMode(editor)
  const args = parseStartupArgs(Bun.argv)
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

  await runJemacs(editor, await createDefaultHost())
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
