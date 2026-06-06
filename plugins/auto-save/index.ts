import { stat } from "node:fs/promises"
import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { fileExists } from "../../src/platform/runtime"

defcustom("auto-save-interval", "number", 30,
  "Seconds of idle time between auto-saves of dirty file-visiting buffers.")
defcustom("auto-save-keystroke-interval", "number", 300,
  "Number of input events between auto-saves; checked after each command.")

const keystrokes = new WeakMap<Editor, number>()
const timers = new WeakMap<Editor, ReturnType<typeof setInterval>>()

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const prev = timers.get(editor)
  if (prev) clearInterval(prev)
  const seconds = getCustom<number>("auto-save-interval") ?? 30
  const timer = setInterval(() => void editor.doAutoSave(), seconds * 1000)
  timers.set(editor, timer)
  ctx.onDispose(() => { clearInterval(timer); timers.delete(editor) })

  ctx.hook("post-command-hook", ({ editor: ed }) => {
    const n = (keystrokes.get(ed) ?? 0) + 1
    if (n >= (getCustom<number>("auto-save-keystroke-interval") ?? 300)) {
      keystrokes.set(ed, 0)
      void ed.doAutoSave()
    } else {
      keystrokes.set(ed, n)
    }
  })

  ctx.hook("find-file-hook", async ({ editor: ed, buffer }) => {
    const autoSave = ed.autoSavePath(buffer)
    if (!autoSave || !(await fileExists(autoSave))) return
    const [autoStat, fileStat] = await Promise.all([
      stat(autoSave).catch(() => null),
      buffer.path ? stat(buffer.path).catch(() => null) : Promise.resolve(null),
    ])
    if (!autoStat || (fileStat && autoStat.mtimeMs <= fileStat.mtimeMs)) return
    ed.message(`${ed.bufferDisplayName(buffer)} has auto save data; consider M-x recover-this-file`)
  })

  ctx.hook("after-save-hook", async ({ editor: ed, buffer }) => {
    await ed.deleteAutoSaveFile(buffer)
  })

  editor.command("recover-this-file", async ({ editor: ed }) => {
    await ed.recoverThisFile()
  }, "Replace buffer text from its #file# auto-save data if newer than the visited file.")

  editor.command("do-auto-save", async ({ editor: ed }) => {
    const n = await ed.doAutoSave()
    ed.message(n ? `Auto-saved ${n} buffer${n === 1 ? "" : "s"}` : "(No buffers need auto-saving)")
  }, "Auto-save all dirty file-visiting buffers now.")
}
