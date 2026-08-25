import type { Editor } from "../kernel/editor"
import type { BufferModel } from "../kernel/buffer"
import { defcustom, getCustom } from "../runtime/custom"

const FILL_COLUMN_LOCAL = "fill-column"

export function currentFillColumn(buffer: BufferModel): number {
  const local = buffer.locals.get(FILL_COLUMN_LOCAL)
  return typeof local === "number" ? local : getCustom<number>("fill-column") ?? 70
}

export function installFillCommands(editor: Editor): void {
  defcustom("fill-column", "integer", 70,
    "Column beyond which automatic line-wrapping should happen.", "fill")

  editor.command("set-fill-column", ({ buffer, editor, prefixArgument }) => {
    const previous = currentFillColumn(buffer)
    const column = prefixArgument ?? buffer.lineCol().col - 1
    buffer.locals.set(FILL_COLUMN_LOCAL, column)
    editor.message(`Fill column set to ${column} (was ${previous})`)
    return column
  }, "Set `fill-column` to the prefix argument, or to the current column.")
}
