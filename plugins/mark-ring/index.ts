import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"

const MARK_RING_MAX = 16
const GLOBAL_MARK_RING_MAX = 16

type GlobalMark = { bufferId: string; position: number }

const globalRings = new WeakMap<Editor, GlobalMark[]>()

export function localMarkRing(buffer: BufferModel): number[] {
  let ring = buffer.locals.get("mark-ring") as number[] | undefined
  if (!ring) {
    ring = []
    buffer.locals.set("mark-ring", ring)
  }
  return ring
}

export function globalMarkRing(editor: Editor): GlobalMark[] {
  let ring = globalRings.get(editor)
  if (!ring) {
    ring = []
    globalRings.set(editor, ring)
  }
  return ring
}

function pushMark(editor: Editor, buffer: BufferModel): void {
  const ring = localMarkRing(buffer)
  if (buffer.mark != null) {
    ring.unshift(buffer.mark)
    if (ring.length > MARK_RING_MAX) ring.length = MARK_RING_MAX
  }
  buffer.setMark()
  const global = globalMarkRing(editor)
  if (global[0]?.bufferId !== buffer.id) {
    global.unshift({ bufferId: buffer.id, position: buffer.mark ?? buffer.point })
    if (global.length > GLOBAL_MARK_RING_MAX) global.length = GLOBAL_MARK_RING_MAX
  }
}

function popMark(buffer: BufferModel): void {
  const ring = localMarkRing(buffer)
  if (ring.length && buffer.mark != null) {
    ring.push(buffer.mark)
    buffer.mark = ring.shift()!
  }
  buffer.deactivateMark()
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  editor.command("set-mark-command", ({ editor, buffer, prefixArgument }) => {
    if (prefixArgument != null) {
      if (buffer.mark == null) {
        editor.message("No mark set in this buffer")
        return
      }
      if (buffer.point === buffer.mark) editor.message("Mark popped")
      buffer.point = clamp(buffer.mark, 0, buffer.text.length)
      popMark(buffer)
      return
    }
    pushMark(editor, buffer)
    editor.message("Mark set")
  }, "Set mark at point, pushing the old mark onto the mark ring; with C-u, jump to mark and pop the ring.")

  editor.command("pop-global-mark", ({ editor }) => {
    const global = globalMarkRing(editor)
    while (global.length && !editor.buffers.has(global[0]!.bufferId)) global.shift()
    if (!global.length) {
      editor.message("No global mark set")
      return
    }
    const head = global.shift()!
    global.push(head)
    const target = editor.switchToBuffer(head.bufferId)
    target.point = clamp(head.position, 0, target.text.length)
  }, "Pop off global mark ring and jump to the top location.")

  editor.key("C-x C-space", "pop-global-mark")
  editor.key("C-x C-@", "pop-global-mark")
}
