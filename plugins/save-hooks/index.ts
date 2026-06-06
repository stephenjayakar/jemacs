import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { CommandAdvice } from "../../src/runtime/advice"
import { defcustom } from "../../src/runtime/custom"

const deleteTrailingLines = defcustom(
  "delete-trailing-lines",
  "boolean",
  true,
  "If non-nil, `delete-trailing-whitespace` deletes trailing empty lines at end of buffer.",
)

export function deleteTrailingWhitespace(buffer: BufferModel, start?: number, end?: number): void {
  const wholeBuffer = start == null && end == null
  const from = start ?? 0
  const to = end ?? buffer.text.length
  const region = buffer.text.slice(from, to)

  let result = region.replace(/[ \t]+$/gm, "")
  if (wholeBuffer && deleteTrailingLines.value) {
    result = result.replace(/\n\n+$/, "\n")
  }
  if (result === region) return

  const oldPoint = buffer.point
  let removed = 0
  if (oldPoint > from) {
    let pos = from
    for (const line of region.split("\n")) {
      const kept = line.replace(/[ \t]+$/, "").length
      const wsStart = pos + kept
      const wsEnd = pos + line.length
      if (oldPoint <= wsStart) break
      removed += Math.min(wsEnd, oldPoint) - wsStart
      if (oldPoint <= wsEnd) break
      pos = wsEnd + 1
    }
  }
  buffer.replaceRange(from, to, result)
  buffer.point = Math.max(0, Math.min(oldPoint - removed, buffer.text.length))
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  editor.command("delete-trailing-whitespace", ({ buffer }) => {
    const useRegion = buffer.markActive && buffer.mark != null && buffer.mark !== buffer.point
    const [start, end] = useRegion
      ? [Math.min(buffer.mark!, buffer.point), Math.max(buffer.mark!, buffer.point)]
      : [undefined, undefined]
    deleteTrailingWhitespace(buffer, start, end)
  }, "Delete trailing whitespace at the end of each line in the region, or the whole buffer.")

  const advice: CommandAdvice = {
    before: async ({ editor, buffer }) => {
      try {
        await editor.runHook("before-save-hook", buffer)
      } catch (err) {
        editor.message(`Before-save hook error: ${err}`)
      }
    },
    after: async ({ editor, buffer }) => {
      await editor.runHook("after-save-hook", buffer)
    },
  }

  ctx.advice("save-buffer", advice)
  ctx.hook("before-save-hook", ({ buffer }) => deleteTrailingWhitespace(buffer))
}
