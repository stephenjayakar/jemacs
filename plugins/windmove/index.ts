import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { WindowId, WindowNode } from "../../src/kernel/window"
import { defcustom, getCustom } from "../../src/runtime/custom"

export type Direction = "left" | "right" | "up" | "down"

type Rect = { x0: number; y0: number; x1: number; y1: number }

const EPS = 1e-9

function collectRects(node: WindowNode, rect: Rect, out: Map<WindowId, Rect>): void {
  if (node.kind === "leaf") {
    out.set(node.id, rect)
    return
  }
  if (node.direction === "horizontal") {
    const mid = (rect.x0 + rect.x1) / 2
    collectRects(node.first, { ...rect, x1: mid }, out)
    collectRects(node.second, { ...rect, x0: mid }, out)
  } else {
    const mid = (rect.y0 + rect.y1) / 2
    collectRects(node.first, { ...rect, y1: mid }, out)
    collectRects(node.second, { ...rect, y0: mid }, out)
  }
}

type Axis = {
  fwd: (r: Rect) => number
  near: (r: Rect) => number
  lo: (r: Rect) => number
  hi: (r: Rect) => number
  sign: 1 | -1
}

const AXES: Record<Direction, Axis> = {
  right: { fwd: r => r.x1, near: r => r.x0, lo: r => r.y0, hi: r => r.y1, sign: 1 },
  left: { fwd: r => r.x0, near: r => r.x1, lo: r => r.y0, hi: r => r.y1, sign: -1 },
  down: { fwd: r => r.y1, near: r => r.y0, lo: r => r.x0, hi: r => r.x1, sign: 1 },
  up: { fwd: r => r.y0, near: r => r.y1, lo: r => r.x0, hi: r => r.x1, sign: -1 },
}

export function windowInDirection(
  layout: WindowNode,
  fromId: WindowId,
  dir: Direction,
  wrap = false,
): WindowId | null {
  const rects = new Map<WindowId, Rect>()
  collectRects(layout, { x0: 0, y0: 0, x1: 1, y1: 1 }, rects)
  const cur = rects.get(fromId)
  if (!cur) return null

  const ax = AXES[dir]
  const ref = (ax.lo(cur) + ax.hi(cur)) / 2
  const edge = ax.sign * ax.fwd(cur)

  type Cand = { id: WindowId; dist: number; cross: number }
  const inDir: Cand[] = []
  const aligned: Cand[] = []

  for (const [id, r] of rects) {
    if (id === fromId) continue
    if (ref < ax.lo(r) - EPS || ref > ax.hi(r) + EPS) continue
    const dist = ax.sign * ax.near(r)
    const cross = Math.abs((ax.lo(r) + ax.hi(r)) / 2 - ref)
    aligned.push({ id, dist, cross })
    if (dist >= edge - EPS) inDir.push({ id, dist, cross })
  }

  const order = (a: Cand, b: Cand) => a.dist - b.dist || a.cross - b.cross
  inDir.sort(order)
  if (inDir.length) return inDir[0]!.id

  if (!wrap || !aligned.length) return null
  aligned.sort(order)
  return aligned[0]!.id
}

function doWindmove(editor: Editor, dir: Direction): void {
  const wrap = getCustom<boolean>("windmove-wrap-around") ?? false
  const target = windowInDirection(editor.windowLayout, editor.selectedWindowId, dir, wrap)
  if (target) editor.selectWindow(target)
  else editor.message(`No window ${dir} from selected window`)
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defcustom("windmove-wrap-around", "boolean", false,
    "Whether movement off the edge of the frame wraps around.")

  editor.command("windmove-left", ({ editor }) => doWindmove(editor, "left"),
    "Select the window to the left of the current one.")
  editor.command("windmove-right", ({ editor }) => doWindmove(editor, "right"),
    "Select the window to the right of the current one.")
  editor.command("windmove-up", ({ editor }) => doWindmove(editor, "up"),
    "Select the window above the current one.")
  editor.command("windmove-down", ({ editor }) => doWindmove(editor, "down"),
    "Select the window below the current one.")

  editor.key("S-left", "windmove-left")
  editor.key("S-right", "windmove-right")
  editor.key("S-up", "windmove-up")
  editor.key("S-down", "windmove-down")
}
