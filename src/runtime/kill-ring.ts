import type { Editor } from "../kernel/editor"
import { defvar } from "./custom"

const MAX_KILL_RING = 60

function rings(): WeakMap<Editor, string[]> {
  return defvar("kill-ring", new WeakMap<Editor, string[]>(), "Per-editor kill ring storage.").value
}

export function getKillRing(editor: Editor): string[] {
  const store = rings()
  let ring = store.get(editor)
  if (!ring) store.set(editor, ring = [])
  return ring
}

export function killRingIndex(editor: Editor, delta: number): number {
  const ring = getKillRing(editor)
  if (!ring.length) return 0
  return ((delta % ring.length) + ring.length) % ring.length
}

export function currentKill(editor: Editor, n = 0): string | null {
  const ring = getKillRing(editor)
  if (!ring.length) return null
  return ring[killRingIndex(editor, n)] ?? null
}

export function killNew(editor: Editor, text: string, options: { append?: boolean; before?: boolean } = {}): void {
  if (!text) return
  const ring = getKillRing(editor)
  if (options.append && ring.length) {
    ring[0] = options.before ? text + ring[0]! : ring[0]! + text
    return
  }
  ring.unshift(text)
  if (ring.length > MAX_KILL_RING) ring.length = MAX_KILL_RING
}
