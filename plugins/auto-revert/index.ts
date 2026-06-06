import { watch, type FSWatcher } from "node:fs"
import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import { type HookContext } from "../../src/kernel/hooks"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { fileExists, readFileText } from "../../src/platform/runtime"

type WatchEntry = {
  watcher: FSWatcher
  timer: ReturnType<typeof setTimeout> | null
}

const state = new WeakMap<Editor, Map<string, WatchEntry>>()

function entries(editor: Editor): Map<string, WatchEntry> {
  let map = state.get(editor)
  if (!map) {
    map = new Map()
    state.set(editor, map)
  }
  return map
}

export function watchedBuffers(editor: Editor): string[] {
  return [...entries(editor).keys()]
}

async function revert(editor: Editor, buffer: BufferModel): Promise<void> {
  if (!buffer.path || buffer.dirty) return
  if (!editor.buffers.has(buffer.id)) return
  if (!(await fileExists(buffer.path))) return
  const text = await readFileText(buffer.path)
  if (text === buffer.text) return
  const atEnd = buffer.point >= buffer.text.length
  buffer.setText(text, false)
  buffer.dirty = false
  if (atEnd) buffer.point = buffer.text.length
  if (getCustom<boolean>("auto-revert-verbose")) {
    editor.message(`Reverting buffer \`${editor.bufferDisplayName(buffer)}'`)
  }
  await editor.changed("auto-revert")
}

function schedule(editor: Editor, buffer: BufferModel): void {
  const watched = entries(editor)
  const entry = watched.get(buffer.id)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  const ms = (getCustom<number>("auto-revert-interval") ?? 0.2) * 1000
  entry.timer = setTimeout(() => {
    entry.timer = null
    void revert(editor, buffer)
  }, ms)
}

function adopt(editor: Editor, buffer: BufferModel): void {
  if (buffer.kind !== "file" || !buffer.path) return
  const watched = entries(editor)
  if (watched.has(buffer.id)) return
  let watcher: FSWatcher
  try {
    watcher = watch(buffer.path, { persistent: false }, () => schedule(editor, buffer))
  } catch {
    return
  }
  watched.set(buffer.id, { watcher, timer: null })
}

function release(editor: Editor, bufferId: string): void {
  const watched = entries(editor)
  const entry = watched.get(bufferId)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  entry.watcher.close()
  watched.delete(bufferId)
}

function releaseAll(editor: Editor): void {
  for (const id of [...entries(editor).keys()]) release(editor, id)
}

function onFindFile({ editor, buffer }: HookContext): void {
  if (editor.isMinorModeEnabled("global-auto-revert-mode")) adopt(editor, buffer)
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defcustom("auto-revert-interval", "number", 0.2,
    "Seconds to wait after a file-change notification before reverting.")
  defcustom("auto-revert-verbose", "boolean", true,
    "When non-nil, echo a message whenever a buffer is auto-reverted.")

  ctx.minorMode({
    name: "global-auto-revert-mode",
    lighter: "",
    global: true,
    onEnable: ed => {
      for (const buf of ed.buffers.values()) adopt(ed, buf)
    },
    onDisable: ed => releaseAll(ed),
  })

  editor.command("global-auto-revert-mode", ({ editor: ed, prefixArgument }) => {
    const enable = prefixArgument == null
      ? !ed.isMinorModeEnabled("global-auto-revert-mode")
      : prefixArgument > 0
    if (enable) ed.enableMinorMode("global-auto-revert-mode")
    else ed.disableMinorMode("global-auto-revert-mode")
    ed.message(`Global-Auto-Revert mode ${enable ? "enabled" : "disabled"}`)
  }, "Toggle automatic reverting of file buffers when they change on disk.")

  ctx.hook("find-file-hook", onFindFile)

  ctx.advice("kill-buffer", {
    after: ({ editor: ed }) => {
      for (const id of [...entries(ed).keys()]) {
        if (!ed.buffers.has(id)) release(ed, id)
      }
    },
  })

  ctx.onDispose(() => releaseAll(editor))
}
