import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  editor.command("copy-to-register", async ({ buffer, editor, args }) => {
    const register = args[0] ?? await editor.prompt("Copy to register: ", "", "register")
    if (!register) return
    if (buffer.mark == null) { editor.message("No mark set in this buffer"); return }
    editor.registers.set(register, { kind: "text", text: buffer.selectedText() })
    editor.message(`Copied region to register ${register}`)
  }, "Copy region into register.")

  editor.command("insert-register", async ({ buffer, editor, args }) => {
    const register = args[0] ?? await editor.prompt("Insert register: ", "", "register")
    if (!register) return
    const value = editor.registers.get(register)
    if (!value) { editor.message(`Register ${register} is empty`); return }
    if (value.kind === "text") { buffer.insert(value.text); return }
    if (value.kind === "rectangle") { buffer.insert(value.lines.join("\n")); return }
    editor.message(`Register ${register} does not contain text`)
  }, "Insert contents of register at point.")


  editor.key("C-x r s", "copy-to-register")
  editor.key("C-x r i", "insert-register")
}
