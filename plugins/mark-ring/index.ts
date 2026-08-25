import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import { defcustom, getCustom } from "../../src/runtime/custom"

const MARK_RING_MAX = 16
const GLOBAL_MARK_RING_MAX = 16

defcustom("set-mark-command-repeat-pop", "boolean", false,
  "When non-nil, repeating set-mark-command after popping mark pops it again.", "editing")

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
  type MarkCommandAction = "push-mark-command" | "pop-to-mark-command" | "pop-global-mark" | null
  let lastMarkCommandAction: MarkCommandAction = null
  const offChanged = editor.events.on("changed", ({ reason }) => {
    if (!reason.startsWith("command:")) return
    const command = reason.slice("command:".length)
    if (command !== "set-mark-command" && command !== "pop-global-mark") lastMarkCommandAction = null
  })
  ctx.onDispose(offChanged)

  const popToMark = (buffer: BufferModel): boolean => {
    if (buffer.mark == null) {
      editor.message("No mark set in this buffer")
      return false
    }
    if (buffer.point === buffer.mark) editor.message("Mark popped")
    buffer.point = clamp(buffer.mark, 0, buffer.text.length)
    popMark(buffer)
    return true
  }

  const setMark = (buffer: BufferModel): void => {
    pushMark(editor, buffer)
    editor.message("Mark set")
  }

  editor.command("set-mark-command", async ({ editor, buffer, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument > 4) {
      setMark(buffer)
      lastMarkCommandAction = "push-mark-command"
      return
    }
    if (prefixArgument != null) {
      if (popToMark(buffer)) lastMarkCommandAction = "pop-to-mark-command"
      else lastMarkCommandAction = null
      return
    }
    if (getCustom<boolean>("set-mark-command-repeat-pop") && lastMarkCommandAction === "pop-to-mark-command") {
      if (popToMark(buffer)) lastMarkCommandAction = "pop-to-mark-command"
      else lastMarkCommandAction = null
      return
    }
    if (getCustom<boolean>("set-mark-command-repeat-pop") && lastMarkCommandAction === "pop-global-mark") {
      await editor.run("pop-global-mark")
      return
    }
    setMark(buffer)
    lastMarkCommandAction = "push-mark-command"
  }, "Set mark at point, pushing the old mark onto the mark ring; with C-u, jump to mark and pop the ring.")

  editor.command("mark-whole-buffer", ({ buffer }) => {
    const originalPoint = buffer.point
    const ring = localMarkRing(buffer)
    ring.unshift(originalPoint)
    if (ring.length > MARK_RING_MAX) ring.length = MARK_RING_MAX
    buffer.mark = buffer.text.length
    buffer.point = 0
    buffer.markActive = true
  }, "Put point at beginning and mark at end of buffer.")

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
    lastMarkCommandAction = "pop-global-mark"
  }, "Pop off global mark ring and jump to the top location.")

  editor.key("C-x C-space", "pop-global-mark")
  editor.key("C-x C-@", "pop-global-mark")
}
