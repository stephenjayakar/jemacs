import type { BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { TERMINAL_SURFACE_LOCAL, type TerminalCell, type TerminalSurfaceModel } from "../../src/display/terminal-surface"

/** Manages the per-buffer TerminalSurfaceModel in buffer.locals. The session
 *  builds a fresh surface on each VT parse and hands it here; this class
 *  diffs against the cached one and only emits editor.changed if a cell
 *  actually moved. This is the per-buffer equivalent of OpenTUI's
 *  OptimizedBuffer diff — a TUI that prints 60 frames/sec but doesn't move
 *  anything ends up doing zero work in the host redraw path. */
export class SurfaceRenderer {
  private disposed = false
  private readonly buffer: BufferModel
  private readonly editor: Editor
  private readonly label: string

  constructor(editor: Editor, buffer: BufferModel, label: string) {
    this.editor = editor
    this.buffer = buffer
    this.label = label
  }

  /** Drop the cached surface so the next updateSurface is treated as a full repaint. */
  invalidate(): void {
    this.buffer.locals.delete(TERMINAL_SURFACE_LOCAL)
  }

  dispose(): void {
    this.disposed = true
    this.buffer.locals.delete(TERMINAL_SURFACE_LOCAL)
  }

  /** Diff `surface` against the cached one; if changed, store + emit. */
  updateSurface(surface: TerminalSurfaceModel): void {
    if (this.disposed) return
    const previous = this.buffer.locals.get(TERMINAL_SURFACE_LOCAL) as TerminalSurfaceModel | undefined
    if (!surfaceChanged(previous ?? null, surface)) return
    this.buffer.locals.set(TERMINAL_SURFACE_LOCAL, surface)
    void this.editor.changed(`${this.label}-render`)
  }
}

/** Cell-level diff: return true iff `next` differs in any way the user would
 *  notice (text, fg, bg, attrs, or cursor position). O(rows*cols) which is
 *  sub-ms for realistic viewport sizes (200x50 = 10k cells). */
export function surfaceChanged(a: TerminalSurfaceModel | null, b: TerminalSurfaceModel): boolean {
  if (!a) return true
  if (a.rows !== b.rows || a.cols !== b.cols) return true
  if (a.cursorRow !== b.cursorRow || a.cursorCol !== b.cursorCol) return true
  for (let y = 0; y < a.rows; y++) {
    const ar = a.cells[y]
    const br = b.cells[y]
    if (!ar || !br) return true
    for (let x = 0; x < a.cols; x++) {
      if (!cellEqual(ar[x], br[x])) return true
    }
  }
  return false
}

function cellEqual(a: TerminalCell | undefined, b: TerminalCell | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.text !== b.text) return false
  if (a.fg !== b.fg) return false
  if (a.bg !== b.bg) return false
  if (!!a.bold !== !!b.bold) return false
  if (!!a.italic !== !!b.italic) return false
  if (!!a.underline !== !!b.underline) return false
  return true
}
