import type { CanvasShapeModel } from "../../src/kernel/extension-points"

/**
 * A tiny drawing language for `canvas-mode` buffers.
 *
 * The buffer text *is* the picture's source. Each line is one command, so a drawing
 * stays diffable, greppable and editable with ordinary text commands -- and the same
 * text remains the TUI fallback when the host has no DOM.
 *
 * Coordinates are 0..1 fractions of the canvas box, matching `CanvasShapeModel`.
 *
 *   # comment
 *   aspect 2
 *   face   keyword
 *   rect   x y w h [fill|stroke]
 *   line   x1 y1 x2 y2
 *   text   x y Some caption
 *   poly   x1 y1 x2 y2 ...          (open polyline)
 *   circle cx cy r                  (approximated as a polygon)
 *   plot   x y w h v1 v2 v3 ...     (sparkline of values, auto-scaled)
 *   bars   x y w h v1 v2 v3 ...     (bar chart of values, auto-scaled)
 */

export type CanvasProgram = {
  aspect: number
  shapes: CanvasShapeModel[]
  errors: CanvasError[]
}

export type CanvasError = {
  /** 0-based line index, so callers can map back to buffer offsets. */
  line: number
  message: string
}

const CIRCLE_SEGMENTS = 48

/** Parse `text` into shapes. Unparseable lines are reported, never thrown. */
export function parseCanvasProgram(text: string): CanvasProgram {
  const shapes: CanvasShapeModel[] = []
  const errors: CanvasError[] = []
  let aspect = 2
  let face: string | undefined

  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!
    const line = raw.replace(/#.*$/, "").trim()
    if (!line) continue

    const [head, ...rest] = line.split(/\s+/)
    const command = (head ?? "").toLowerCase()
    const fail = (message: string) => errors.push({ line: index, message })

    // `text` keeps its caption verbatim, so it cannot use the numeric parser.
    if (command === "text") {
      const [x, y] = rest.slice(0, 2).map(Number)
      const caption = rest.slice(2).join(" ")
      if (!isFinite(x!) || !isFinite(y!)) {
        fail("text needs: x y caption")
        continue
      }
      shapes.push({ kind: "text", x: x!, y: y!, text: caption, face })
      continue
    }

    const nums = rest.filter(t => !/^(fill|stroke)$/i.test(t)).map(Number)
    const bad = nums.some(n => !isFinite(n))

    switch (command) {
      case "aspect": {
        if (bad || nums.length < 1 || nums[0]! <= 0) {
          fail("aspect needs a positive number")
          break
        }
        aspect = nums[0]!
        break
      }
      case "face": {
        face = rest[0] || undefined
        break
      }
      case "rect": {
        if (bad || nums.length < 4) {
          fail("rect needs: x y width height")
          break
        }
        shapes.push({
          kind: "rect",
          x: nums[0]!,
          y: nums[1]!,
          width: nums[2]!,
          height: nums[3]!,
          face,
          fill: !/\bstroke\b/i.test(line),
        })
        break
      }
      case "line": {
        if (bad || nums.length < 4) {
          fail("line needs: x1 y1 x2 y2")
          break
        }
        shapes.push({ kind: "line", x1: nums[0]!, y1: nums[1]!, x2: nums[2]!, y2: nums[3]!, face })
        break
      }
      case "poly": {
        if (bad || nums.length < 4 || nums.length % 2 !== 0) {
          fail("poly needs an even list of x y pairs")
          break
        }
        for (let i = 0; i + 3 < nums.length; i += 2) {
          shapes.push({ kind: "line", x1: nums[i]!, y1: nums[i + 1]!, x2: nums[i + 2]!, y2: nums[i + 3]!, face })
        }
        break
      }
      case "circle": {
        if (bad || nums.length < 3) {
          fail("circle needs: cx cy r")
          break
        }
        pushCircle(shapes, nums[0]!, nums[1]!, nums[2]!, aspect, face)
        break
      }
      case "plot":
      case "bars": {
        if (bad || nums.length < 5) {
          fail(command + " needs: x y width height v1 v2 ...")
          break
        }
        const x = nums[0]!
        const y = nums[1]!
        const w = nums[2]!
        const h = nums[3]!
        const values = nums.slice(4)
        if (command === "plot") pushPlot(shapes, x, y, w, h, values, face)
        else pushBars(shapes, x, y, w, h, values, face)
        break
      }
      default:
        fail("unknown command: " + command)
    }
  }

  return { aspect, shapes, errors }
}

/**
 * Approximate a circle with line segments.
 *
 * The x radius is divided by `aspect` because canvas coordinates are fractions of a box
 * that is usually wider than it is tall; without the correction circles render as ovals.
 */
function pushCircle(
  shapes: CanvasShapeModel[],
  cx: number,
  cy: number,
  r: number,
  aspect: number,
  face: string | undefined,
): void {
  const rx = r / (aspect > 0 ? aspect : 1)
  let prevX = cx + rx
  let prevY = cy
  for (let i = 1; i <= CIRCLE_SEGMENTS; i++) {
    const theta = (i / CIRCLE_SEGMENTS) * Math.PI * 2
    const nx = cx + Math.cos(theta) * rx
    const ny = cy + Math.sin(theta) * r
    shapes.push({ kind: "line", x1: prevX, y1: prevY, x2: nx, y2: ny, face })
    prevX = nx
    prevY = ny
  }
}

/** Min/max of `values`, widened when every sample is identical so lines stay centred. */
function extent(values: number[]): [number, number] {
  const min = Math.min(...values)
  const max = Math.max(...values)
  return min === max ? [min - 1, max + 1] : [min, max]
}

function pushPlot(
  shapes: CanvasShapeModel[],
  x: number,
  y: number,
  w: number,
  h: number,
  values: number[],
  face: string | undefined,
): void {
  const [min, max] = extent(values)
  const at = (i: number): [number, number] => [
    x + (values.length === 1 ? 0 : (i / (values.length - 1)) * w),
    y + h - ((values[i]! - min) / (max - min)) * h,
  ]
  for (let i = 0; i + 1 < values.length; i++) {
    const [x1, y1] = at(i)
    const [x2, y2] = at(i + 1)
    shapes.push({ kind: "line", x1, y1, x2, y2, face })
  }
}

function pushBars(
  shapes: CanvasShapeModel[],
  x: number,
  y: number,
  w: number,
  h: number,
  values: number[],
  face: string | undefined,
): void {
  const max = Math.max(...values, 0)
  const slot = w / values.length
  const barWidth = slot * 0.7
  for (let i = 0; i < values.length; i++) {
    const height = max <= 0 ? 0 : (values[i]! / max) * h
    shapes.push({
      kind: "rect",
      x: x + i * slot + (slot - barWidth) / 2,
      y: y + h - height,
      width: barWidth,
      height,
      face,
      fill: true,
    })
  }
}
