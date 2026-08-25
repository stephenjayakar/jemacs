import type { Editor } from "../kernel/editor"
import { defvar } from "./custom"

const MAX_KILL_RING = 60

/** Emacs's `interprogram-cut-function`: called with the new head of the kill
 *  ring so the host can mirror it to the system clipboard. Installed by
 *  lisp/simple (pbcopy on macOS); unset elsewhere, so killing stays local. */
type InterprogramCut = (text: string) => void
let interprogramCut: InterprogramCut | null = null

export function setInterprogramCutFunction(fn: InterprogramCut | null): void {
  interprogramCut = fn
}

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

/** `cut: false` records the text without mirroring it back out. Used when the
 *  text already came from the system clipboard, so we do not re-copy it. */
export function killNew(editor: Editor, text: string, options: { append?: boolean; before?: boolean; cut?: boolean } = {}): void {
  if (!text) return
  const ring = getKillRing(editor)
  if (options.append && ring.length) {
    ring[0] = options.before ? text + ring[0]! : ring[0]! + text
  } else {
    ring.unshift(text)
    if (ring.length > MAX_KILL_RING) ring.length = MAX_KILL_RING
  }
  if (options.cut !== false) interprogramCut?.(ring[0]!)
}
