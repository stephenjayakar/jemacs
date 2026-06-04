import { Editor } from "./kernel/editor"
import { installDefaultConfig, installDefaultHooks } from "./config"
import { installDefaultModes } from "./modes/default-modes"
import { installLspMode } from "./lsp/install"
import { installXref } from "./xref/install"
import { startOpenTui } from "./ui/opentui"

async function main(): Promise<void> {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  installLspMode(editor)
  installDefaultHooks(editor)
  installXref(editor)

  const file = Bun.argv[2]
  if (file) await editor.openFile(file)

  await startOpenTui(editor)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
