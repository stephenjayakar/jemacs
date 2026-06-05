import type { BufferModel } from "../kernel/buffer"
import type { Editor } from "../kernel/editor"
import { defineMinorMode } from "./minor-mode"

/** True when the line-number gutter should render for `buffer`. Global linum
 *  applies only to file-visiting buffers; any other buffer opts in by carrying
 *  "linum-mode" in its own minorModes set (t-8c81ab4c). */
export function linumActiveFor(editor: Editor, buffer: BufferModel): boolean {
  return editor.isMinorModeEnabled("linum-mode", buffer)
    && (buffer.kind === "file" || buffer.minorModes.has("linum-mode"))
}

export function installLinumMode(): void {
  defineMinorMode({
    name: "linum-mode",
    lighter: " Lin",
    global: true,
    onEnable: (editor, buffer) => {
      buffer?.minorModes.add("linum-mode")
      editor.showLineNumbers = buf => linumActiveFor(editor, buf ?? editor.currentBuffer)
    },
    onDisable: (_editor, buffer) => {
      buffer?.minorModes.delete("linum-mode")
    },
  })
}
