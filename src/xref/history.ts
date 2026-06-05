import type { Editor } from "../kernel/editor"
import type { BufferModel } from "../kernel/buffer"

type XrefMark = { bufferId: string; point: number }

type XrefHistory = { backward: XrefMark[]; forward: XrefMark[] }

const histories = new WeakMap<Editor, XrefHistory>()

function history(editor: Editor): XrefHistory {
  let h = histories.get(editor)
  if (!h) {
    h = { backward: [], forward: [] }
    histories.set(editor, h)
  }
  return h
}

export function xrefPushMark(editor: Editor, buffer: BufferModel): void {
  const h = history(editor)
  h.backward.push({ bufferId: buffer.id, point: buffer.point })
  h.forward = []
  if (buffer.mark == null) buffer.mark = buffer.point
}

export function xrefGoBack(editor: Editor): boolean {
  const h = history(editor)
  const mark = h.backward.pop()
  if (!mark) return false
  h.forward.push({ bufferId: editor.currentBuffer.id, point: editor.currentBuffer.point })
  return restoreMark(editor, mark)
}

export function xrefGoForward(editor: Editor): boolean {
  const h = history(editor)
  const mark = h.forward.pop()
  if (!mark) return false
  h.backward.push({ bufferId: editor.currentBuffer.id, point: editor.currentBuffer.point })
  return restoreMark(editor, mark)
}

function restoreMark(editor: Editor, mark: XrefMark): boolean {
  const buffer = editor.buffers.get(mark.bufferId)
  if (!buffer) return false
  editor.switchToBuffer(mark.bufferId)
  buffer.point = Math.max(0, Math.min(mark.point, buffer.text.length))
  editor.setSelectedWindowPoint(buffer.point)
  void editor.changed("xref-go")
  return true
}
