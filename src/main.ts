import { Editor } from "./kernel/editor"
import { installDefaultCommands } from "./init/default-commands"
import { installDefaultModes } from "./modes/default-modes"
import { installLspMode } from "./lsp/install"
import { startOpenTui } from "./ui/opentui"

async function main(): Promise<void> {
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  installLspMode(editor)

  const file = Bun.argv[2]
  if (file) await editor.openFile(file)

  await startOpenTui(editor)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
