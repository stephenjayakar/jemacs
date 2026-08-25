import type { BufferModel } from "../kernel/buffer"
import type { Editor } from "../kernel/editor"
import { defcustom } from "../runtime/custom"
import { defineMinorMode } from "./minor-mode"

export type DisplayLineNumbersType = true | "relative" | "visual"

/** True when the line-number gutter should render for `buffer`. Global linum
 *  applies only to file-visiting buffers; any other buffer opts in by carrying
 *  "linum-mode" in its own minorModes set (t-8c81ab4c). */
export function linumActiveFor(editor: Editor, buffer: BufferModel): boolean {
  return lineNumbersActiveFor(editor, buffer)
}

export function lineNumbersActiveFor(editor: Editor, buffer: BufferModel): boolean {
  const enabled = editor.isMinorModeEnabled("display-line-numbers-mode", buffer)
    || editor.isMinorModeEnabled("linum-mode", buffer)
  return enabled && (buffer.kind === "file"
    || buffer.minorModes.has("display-line-numbers-mode")
    || buffer.minorModes.has("linum-mode"))
}

export function installLinumMode(): void {
  defcustom<DisplayLineNumbersType>(
    "display-line-numbers-type",
    "sexp",
    true,
    "Type of line numbers to display: true for absolute, 'relative', or 'visual'.",
    "display",
  )
  const wirePredicate = (editor: Editor): void => {
    editor.showLineNumbers = buf => lineNumbersActiveFor(editor, buf ?? editor.currentBuffer)
  }
  defineMinorMode({
    name: "display-line-numbers-mode",
    lighter: " Ln",
    global: true,
    onEnable: (editor, buffer) => {
      buffer?.minorModes.add("display-line-numbers-mode")
      wirePredicate(editor)
    },
    onDisable: (_editor, buffer) => {
      buffer?.minorModes.delete("display-line-numbers-mode")
    },
  })
  defineMinorMode({
    name: "linum-mode",
    lighter: " Lin",
    global: true,
    onEnable: (editor, buffer) => {
      buffer?.minorModes.add("linum-mode")
      wirePredicate(editor)
    },
    onDisable: (_editor, buffer) => {
      buffer?.minorModes.delete("linum-mode")
    },
  })
}
