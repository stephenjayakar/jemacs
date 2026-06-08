import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  editor.command("copy-to-register", async ({ buffer, editor, args, prefixArgument }) => {
    const register = args[0] ?? await editor.prompt("Copy to register: ", "", "register")
    if (!register) return
    if (buffer.mark == null) { editor.message("No mark set in this buffer"); return }
    const [start, end] = [buffer.mark, buffer.point].sort((a, b) => a - b)
    editor.registers.set(register, { kind: "text", text: buffer.text.slice(start, end) })
    if (prefixArgument != null) buffer.deleteRange(start, end)
    editor.message(`Copied region to register ${register}`)
  }, "Copy region into register; with prefix arg, delete the region after copying.")

  editor.command("insert-register", async ({ buffer, editor, args, prefixArgument }) => {
    const register = args[0] ?? await editor.prompt("Insert register: ", "", "register")
    if (!register) return
    const value = editor.registers.get(register)
    if (!value) { editor.message(`Register ${register} is empty`); return }
    const text = value.kind === "text" ? value.text : value.kind === "rectangle" ? value.lines.join("\n") : null
    if (text != null) {
      const start = buffer.point
      buffer.insert(text)
      const end = buffer.point
      if (prefixArgument != null) {
        buffer.mark = end
        buffer.point = start
      } else {
        buffer.mark = start
      }
      buffer.markActive = false
      return
    }
    editor.message(`Register ${register} does not contain text`)
  }, "Insert contents of register at point.")


  editor.key("C-x r s", "copy-to-register")
  editor.key("C-x r x", "copy-to-register")
  editor.key("C-x r i", "insert-register")
  editor.key("C-x r g", "insert-register")
}
