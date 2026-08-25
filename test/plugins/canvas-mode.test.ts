import { describe, expect, test } from "bun:test"
import { parseCanvasProgram } from "../../plugins/canvas-mode/draw"
import { interpolate } from "../../plugins/canvas-mode"
import { DEMOS } from "../../plugins/canvas-mode/demos"

describe("parseCanvasProgram", () => {
  test("parses rect, line and text", () => {
    const program = parseCanvasProgram([
      "rect 0 0 0.5 0.5",
      "line 0 0 1 1",
      "text 0.1 0.2 hello world",
    ].join("\n"))
    expect(program.errors).toEqual([])
    expect(program.shapes).toEqual([
      { kind: "rect", x: 0, y: 0, width: 0.5, height: 0.5, face: undefined, fill: true },
      { kind: "line", x1: 0, y1: 0, x2: 1, y2: 1, face: undefined },
      { kind: "text", x: 0.1, y: 0.2, text: "hello world", face: undefined },
    ])
  })

  test("ignores comments and blank lines", () => {
    const program = parseCanvasProgram("# a comment\n\n  \nrect 0 0 1 1 # trailing\n")
    expect(program.errors).toEqual([])
    expect(program.shapes).toHaveLength(1)
  })

  test("stroke keyword produces an unfilled rect", () => {
    const [shape] = parseCanvasProgram("rect 0 0 1 1 stroke").shapes
    expect(shape).toMatchObject({ kind: "rect", fill: false })
  })

  test("face applies to following shapes only", () => {
    const program = parseCanvasProgram("line 0 0 1 1\nface keyword\nline 0 1 1 0")
    expect(program.shapes[0]).toMatchObject({ face: undefined })
    expect(program.shapes[1]).toMatchObject({ face: "keyword" })
  })

  test("aspect is captured and defaults to 2", () => {
    expect(parseCanvasProgram("").aspect).toBe(2)
    expect(parseCanvasProgram("aspect 1.5").aspect).toBe(1.5)
  })

  test("reports errors with line numbers but keeps parsing", () => {
    const program = parseCanvasProgram("rect 0 0\nline 0 0 1 1\nbogus 1 2")
    expect(program.shapes).toHaveLength(1)
    expect(program.errors.map(e => e.line)).toEqual([0, 2])
    expect(program.errors[1]!.message).toContain("unknown command")
  })

  test("poly emits one segment per adjacent pair", () => {
    const program = parseCanvasProgram("poly 0 0 1 0 1 1")
    expect(program.shapes).toHaveLength(2)
    expect(program.shapes[1]).toMatchObject({ x1: 1, y1: 0, x2: 1, y2: 1 })
  })

  test("poly rejects an odd coordinate count", () => {
    expect(parseCanvasProgram("poly 0 0 1").errors).toHaveLength(1)
  })

  test("circle closes back on itself", () => {
    const shapes = parseCanvasProgram("circle 0.5 0.5 0.25").shapes
    expect(shapes.length).toBeGreaterThan(8)
    const first = shapes[0] as { x1: number; y1: number }
    const last = shapes[shapes.length - 1] as { x2: number; y2: number }
    expect(last.x2).toBeCloseTo(first.x1, 6)
    expect(last.y2).toBeCloseTo(first.y1, 6)
  })

  test("bars scale to the largest value", () => {
    const shapes = parseCanvasProgram("bars 0 0 1 1 5 10").shapes as Array<{ height: number }>
    expect(shapes).toHaveLength(2)
    expect(shapes[0]!.height).toBeCloseTo(0.5, 6)
    expect(shapes[1]!.height).toBeCloseTo(1, 6)
  })

  test("plot spans the full width and inverts the y axis", () => {
    const shapes = parseCanvasProgram("plot 0 0 1 1 0 1").shapes as Array<{
      x1: number; y1: number; x2: number; y2: number
    }>
    expect(shapes).toHaveLength(1)
    // Lowest value sits at the bottom (y = 1), highest at the top (y = 0).
    expect(shapes[0]!.y1).toBeCloseTo(1, 6)
    expect(shapes[0]!.y2).toBeCloseTo(0, 6)
  })

  test("plot of identical values does not divide by zero", () => {
    const shapes = parseCanvasProgram("plot 0 0 1 1 3 3 3").shapes as Array<{ y1: number }>
    for (const shape of shapes) expect(Number.isFinite(shape.y1)).toBe(true)
  })
})

describe("interpolate", () => {
  test("substitutes t", () => {
    expect(interpolate("circle {t} 0.5 0.1", 0.25)).toBe("circle 0.25 0.5 0.1")
  })

  test("evaluates arithmetic and functions", () => {
    expect(interpolate("{0.5+0.5*sin(0)}", 0)).toBe("0.5")
    expect(interpolate("{2*3-1}", 0)).toBe("5")
    expect(interpolate("{abs(0-2)}", 0)).toBe("2")
    expect(interpolate("{sqrt(9)}", 0)).toBe("3")
  })

  test("respects precedence and parentheses", () => {
    expect(interpolate("{1+2*3}", 0)).toBe("7")
    expect(interpolate("{(1+2)*3}", 0)).toBe("9")
  })

  test("leaves malformed expressions untouched rather than throwing", () => {
    expect(interpolate("{1+}", 0)).toBe("{1+}")
    expect(interpolate("{)(}", 0)).toBe("{)(}")
  })

  test("does not execute arbitrary code", () => {
    // The evaluator is a parser, not eval: identifiers it does not know fail closed.
    const hostile = "{process.exit(1)}"
    expect(interpolate(hostile, 0)).toBe(hostile)
    expect(interpolate("{globalThis}", 0)).toBe("{globalThis}")
  })

  test("division by zero fails closed", () => {
    expect(interpolate("{1/0}", 0)).toBe("{1/0}")
  })
})

describe("built-in demos", () => {
  test("every demo parses without errors at t = 0", () => {
    for (const demo of DEMOS) {
      const program = parseCanvasProgram(interpolate(demo.source, 0))
      expect({ demo: demo.name, errors: program.errors }).toEqual({ demo: demo.name, errors: [] })
      expect(program.shapes.length).toBeGreaterThan(0)
    }
  })

  test("animated demos still parse partway through the clock", () => {
    for (const demo of DEMOS.filter(d => d.animated)) {
      for (const t of [0.7, 1.9, 4.2]) {
        const program = parseCanvasProgram(interpolate(demo.source, t))
        expect({ demo: demo.name, t, errors: program.errors })
          .toEqual({ demo: demo.name, t, errors: [] })
      }
    }
  })

  test("animated demos actually change with t", () => {
    for (const demo of DEMOS.filter(d => d.animated)) {
      expect(interpolate(demo.source, 0)).not.toBe(interpolate(demo.source, 1.3))
    }
  })
})
