import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defineMode, type WebSurfaceModel } from "../../src/modes/mode"
import { Keymap } from "../../src/kernel/keymap"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { parseCanvasProgram } from "./draw"
import { DEMOS, demoIndexText } from "./demos"

/**
 * `canvas-mode`: buffers whose text is a drawing program, rendered as a real canvas in
 * the Electron GUI.
 *
 * The mode publishes a `webSurface`, which the GUI paints and the TUI ignores -- so a
 * drawing is a plain, editable text file everywhere, and a picture where a DOM exists.
 */

defcustom(
  "canvas-animate-interval",
  "number",
  100,
  "Milliseconds between frames of `canvas-animate`.",
)

/** Buffers currently animating, with the timer that drives them. */
const animations = new WeakMap<BufferModel, ReturnType<typeof setInterval>>()

/** `t` for animated demos, advanced by the animation timer. */
const CANVAS_TIME = "canvas-time"

/**
 * Substitute `{t}` and simple `{expr}` arithmetic before parsing.
 *
 * Animation needs the drawing to be a *function* of time, but the drawing language is
 * deliberately non-programmable. Interpolation is the smallest thing that buys motion
 * without turning the format into a scripting language: only the four operators and the
 * `t` variable are recognised, so a malformed expression degrades to a parse error on
 * one line rather than executing anything.
 */
export function interpolate(text: string, t: number): string {
  return text.replace(/\{([^{}]*)\}/g, (whole, expr: string) => {
    const substituted = expr.replace(/\bt\b/g, String(t))
    if (!/^[-+*/(). 0-9a-z,]*$/i.test(substituted)) return whole
    const value = evaluateExpression(substituted)
    return value == null ? whole : trimNumber(value)
  })
}

/** Round to 4dp and drop trailing zeros, so generated text stays readable. */
function trimNumber(value: number): string {
  return String(Math.round(value * 10000) / 10000)
}

/**
 * Evaluate a arithmetic expression with `sin`/`cos`/`abs` support.
 *
 * A hand-written recursive-descent parser rather than `Function(...)`: the text comes
 * from a buffer, and buffers can come from anywhere.
 */
function evaluateExpression(input: string): number | null {
  let pos = 0
  const src = input.replace(/\s+/g, "")

  const peek = () => src[pos]
  const eat = (c: string) => (src[pos] === c ? (pos++, true) : false)

  const parseExpr = (): number | null => {
    let left = parseTerm()
    if (left == null) return null
    for (;;) {
      if (eat("+")) {
        const right = parseTerm()
        if (right == null) return null
        left += right
      } else if (eat("-")) {
        const right = parseTerm()
        if (right == null) return null
        left -= right
      } else return left
    }
  }

  const parseTerm = (): number | null => {
    let left = parseFactor()
    if (left == null) return null
    for (;;) {
      if (eat("*")) {
        const right = parseFactor()
        if (right == null) return null
        left *= right
      } else if (eat("/")) {
        const right = parseFactor()
        if (right == null || right === 0) return null
        left /= right
      } else return left
    }
  }

  const parseFactor = (): number | null => {
    if (eat("-")) {
      const value = parseFactor()
      return value == null ? null : -value
    }
    if (eat("(")) {
      const value = parseExpr()
      if (value == null || !eat(")")) return null
      return value
    }
    const fn = /^(sin|cos|abs|sqrt)\(/.exec(src.slice(pos))
    if (fn) {
      pos += fn[0].length
      const arg = parseExpr()
      if (arg == null || !eat(")")) return null
      switch (fn[1]) {
        case "sin": return Math.sin(arg)
        case "cos": return Math.cos(arg)
        case "abs": return Math.abs(arg)
        default: return arg < 0 ? null : Math.sqrt(arg)
      }
    }
    const num = /^\d*\.?\d+/.exec(src.slice(pos))
    if (!num) return null
    pos += num[0].length
    return Number(num[0])
  }

  const result = parseExpr()
  return result != null && pos === src.length && isFinite(result) ? result : null
}

/** Build the GUI surface for a canvas buffer. */
function canvasSurface(buffer: BufferModel): WebSurfaceModel | null {
  const t = (buffer.locals.get(CANVAS_TIME) as number | undefined) ?? 0
  const program = parseCanvasProgram(interpolate(buffer.text, t))

  const nodes = program.errors.length
    ? [{
        kind: "column" as const,
        children: program.errors.slice(0, 5).map(error => ({
          kind: "text" as const,
          face: "error",
          text: `line ${error.line + 1}: ${error.message}`,
        })),
      }]
    : []

  return {
    kind: "web",
    nodes,
    canvas: { aspect: program.aspect, shapes: program.shapes },
  }
}

function stopAnimation(buffer: BufferModel): boolean {
  const timer = animations.get(buffer)
  if (!timer) return false
  clearInterval(timer)
  animations.delete(buffer)
  return true
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const keymap = new Keymap("canvas-mode-map")
  keymap.bind("C-c C-a", "canvas-animate")
  keymap.bind("C-c C-r", "canvas-redraw")

  defineMode({
    name: "canvas",
    parent: "text",
    commentStart: "#",
    keymap,
    webSurface: canvasSurface,
  })

  ctx.command("canvas-mode", ({ editor, buffer }) => {
    editor.enterMode(buffer, "canvas")
    editor.message("Canvas mode. C-c C-a animates, C-c C-r redraws.")
  }, "Render the buffer's drawing program on a canvas (GUI only).")

  ctx.command("canvas-redraw", ({ editor, buffer }) => {
    const program = parseCanvasProgram(interpolate(buffer.text, 0))
    editor.message(program.errors.length
      ? `canvas: ${program.errors.length} error(s); first on line ${program.errors[0]!.line + 1}`
      : `canvas: ${program.shapes.length} shapes`)
  }, "Re-parse the canvas buffer and report shape/error counts.")

  ctx.command("canvas-animate", ({ editor, buffer }) => {
    if (stopAnimation(buffer)) {
      editor.message("canvas: animation stopped")
      return
    }
    const interval = Math.max(16, getCustom<number>("canvas-animate-interval") ?? 100)
    const timer = setInterval(() => {
      // Stop animating buffers the user has killed, otherwise the timer keeps a dead
      // buffer alive for the life of the process.
      if (!editor.buffers.has(buffer.id)) {
        stopAnimation(buffer)
        return
      }
      const t = ((buffer.locals.get(CANVAS_TIME) as number | undefined) ?? 0) + 0.1
      buffer.locals.set(CANVAS_TIME, Math.round(t * 1000) / 1000)
      // Mutating a buffer-local does not itself schedule a redisplay, so without this
      // the canvas only repaints when some unrelated event happens to trigger one.
      void editor.changed("canvas-animate")
    }, interval)
    ;(timer as { unref?: () => void }).unref?.()
    animations.set(buffer, timer)
    editor.message("canvas: animating (C-c C-a to stop)")
  }, "Toggle animation, advancing `{t}` in the drawing program.")

  ctx.command("canvas-demo", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Canvas demo: ", {
      collection: DEMOS.map(demo => demo.name),
    })
    if (!name) return
    const demo = DEMOS.find(d => d.name === name)
    if (!demo) {
      editor.message(`No such canvas demo: ${name}`)
      return
    }
    const buffer = editor.scratch(`*canvas: ${demo.name}*`, demo.source, "canvas")
    buffer.locals.set(CANVAS_TIME, 0)
    editor.message(`${demo.name} — ${demo.description}`)
  }, "Open one of the built-in canvas demos.")

  ctx.command("canvas-demos", ({ editor }) => {
    editor.scratch("*canvas demos*", demoIndexText(), "text")
  }, "List the built-in canvas demos.")

  ctx.onDispose(() => {
    for (const buffer of editor.buffers.values()) stopAnimation(buffer)
  })
}
