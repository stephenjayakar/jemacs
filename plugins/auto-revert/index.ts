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
  poll: ReturnType<typeof setInterval> | null
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

/**
 * True when a fallback poll is armed for `bufferId`.
 *
 * Exposed so a test can prove the interval is both created and cleared; a leaked
 * interval is invisible from the outside otherwise, and `unref` means it would not
 * even hold the process open to reveal itself.
 */
export function pollArmedFor(editor: Editor, bufferId: string): boolean {
  return entries(editor).get(bufferId)?.poll != null
}

/**
 * Close the `fs.watch` handle for `bufferId` while leaving its fallback poll running.
 *
 * This is the dropped-notification case made deterministic. A test cannot ask macOS to
 * drop an FSEvents callback on demand, so it removes the notification path outright:
 * anything that still reverts the buffer afterwards is the poll.
 */
export function closeWatcherFor(editor: Editor, bufferId: string): void {
  const entry = entries(editor).get(bufferId)
  if (!entry) return
  entry.watcher.close()
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
  // Emacs keeps `auto-revert-check-vc-info`-style polling alongside file notifications
  // for the same reason this does: a notification is best-effort. macOS in particular
  // drops FSEvents callbacks when the process is busy, and a dropped event means the
  // buffer silently never reverts. The poll is the backstop that makes reverting
  // eventual rather than merely likely.
  //
  // `unref` keeps the interval from holding the process open, matching the
  // `persistent: false` watcher above: neither should keep a quitting editor alive.
  const seconds = getCustom<number>("auto-revert-poll-interval") ?? 1
  let poll: ReturnType<typeof setInterval> | null = null
  if (seconds > 0) {
    poll = setInterval(() => { void revert(editor, buffer) }, seconds * 1000)
    ;(poll as unknown as { unref?: () => void }).unref?.()
  }
  watched.set(buffer.id, { watcher, timer: null, poll })
}

function release(editor: Editor, bufferId: string): void {
  const watched = entries(editor)
  const entry = watched.get(bufferId)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  if (entry.poll) clearInterval(entry.poll)
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
    "Seconds to wait after a file-change notification before reverting.", "files")
  defcustom("auto-revert-verbose", "boolean", true,
    "When non-nil, echo a message whenever a buffer is auto-reverted.", "files")
  defcustom("auto-revert-poll-interval", "number", 1,
    "Seconds between fallback polls for buffers whose file-change notification was dropped. Zero disables polling.", "files")

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
