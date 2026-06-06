import type { Editor } from "../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../src/runtime/plugin-context"

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  editor.command("minibuffer-complete", async ({ editor }) => editor.minibufferComplete(), "Complete the current minibuffer input.")
  editor.command("exit-minibuffer", ({ editor }) => editor.minibufferSubmit(), "Submit the minibuffer.")
  editor.command("abort-recursive-edit", ({ editor }) => editor.minibufferCancel(), "Abort the minibuffer or recursive edit.")
  editor.command("previous-history-element", ({ editor }) => editor.minibufferPreviousHistory(), "Move to the previous minibuffer history element.")
  editor.command("next-history-element", ({ editor }) => editor.minibufferNextHistory(), "Move to the next minibuffer history element.")

  editor.command("execute-extended-command", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("M-x ", { collection: editor.commands.names(), history: "command" })
    if (!name) return
    const rest = args.length > 1 ? args.slice(1) : []
    await editor.run(name, rest)
  }, "Prompt for and run a command.")

  editor.key("M-x", "execute-extended-command")

  editor.defineKey("minibuffer", "tab", "minibuffer-complete")
  editor.defineKey("minibuffer", "C-i", "minibuffer-complete")
  editor.defineKey("minibuffer", "enter", "exit-minibuffer")
  editor.defineKey("minibuffer", "C-m", "exit-minibuffer")
  editor.defineKey("minibuffer", "return", "exit-minibuffer")
  editor.defineKey("minibuffer", "esc", "abort-recursive-edit")
  editor.defineKey("minibuffer", "up", "previous-history-element")
  editor.defineKey("minibuffer", "down", "next-history-element")
}
