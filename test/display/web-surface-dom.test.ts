/**
 * Executes the real DOM renderer against a real document.
 *
 * `test/display/web-surface.test.ts` covers the *model* reaching the pane; this file
 * covers the other half -- that `presentDomFrame` actually builds the element tree, wires
 * the click handlers, and drives the canvas 2D context. happy-dom supplies genuine
 * elements and event dispatch, so the click assertions exercise the same listener the
 * Electron renderer registers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Window } from "happy-dom"

const window = new Window({ url: "http://localhost" })
// dom-frame reaches for the ambient `document`, exactly as it does inside Electron's
// renderer process. Installing it before the import is what makes the module usable here.
const globals = globalThis as Record<string, unknown>
globals.window = window
globals.document = window.document
globals.HTMLElement = window.HTMLElement
globals.HTMLCanvasElement = window.HTMLCanvasElement
globals.requestAnimationFrame = (callback: FrameRequestCallback) => { void callback(0); return 0 }
globals.cancelAnimationFrame = () => {}

const { presentDomFrame } = await import("../../src/display/dom-frame")
const { serializeDisplayModel } = await import("../../src/display/serialize")
const { buildDisplayModel } = await import("../../src/display/build-display-model")
const { defineMode, modes } = await import("../../src/modes/mode")
const { makeEditor } = await import("../plugins/helper")
type WebSurfaceModel = import("../../src/kernel/extension-points").WebSurfaceModel

const NL = String.fromCharCode(10)
const MODE = "web-surface-dom-probe"

/**
 * A test-report surface: a verdict line, four clickable result rows with duration bars,
 * a link row, and a duration canvas.
 *
 * Shaped after what a real build-tool mode emits, because that combination -- rows,
 * bars, links, canvas -- is what exercises every branch of the renderer at once. Built
 * here rather than imported from a mode so core stays standalone.
 */
const RESULTS: Array<{ name: string; face: string; label: string; seconds: number }> = [
  { name: "ProbeTest.testRaises", face: "error", label: "ERR", seconds: 0.8 },
  { name: "ProbeTest.testFailsAssertion", face: "error", label: "FAIL", seconds: 0.4 },
  { name: "ProbeTest.testParameterizedalpha", face: "success", label: "PASS", seconds: 0.2 },
  { name: "ProbeTest.testPasses", face: "success", label: "PASS", seconds: 0.1 },
]

const REPORT_URL = "http://reports.test/c1ddb456-95f8-498a-8cdc-04d9aca12fdd"
const VERDICT = "probe_test FAILED - 2 passed, 2 failed (1.0s)"

const BODY = [
  VERDICT,
  "  ERR   ProbeTest.testRaises (0.8s)",
].join(NL)

/** Builds the surface above; `results` lets a test swap in a different run. */
function reportSurface(results = RESULTS, verdict = VERDICT): WebSurfaceModel {
  const slowest = Math.max(...results.map(result => result.seconds), 0)
  const rowHeight = 1 / results.length
  return {
    kind: "web",
    nodes: [
      { kind: "row", children: [{ kind: "text", text: verdict, face: "error" }] },
      ...results.map(result => ({
        kind: "row" as const,
        id: result.name,
        action: "probe-run-test",
        title: `Run ${result.name}`,
        children: [
          { kind: "text" as const, text: result.label, face: result.face },
          { kind: "text" as const, text: result.name },
          { kind: "bar" as const, value: result.seconds / slowest, text: `${result.seconds}s`, face: result.face },
        ],
      })),
      {
        kind: "row",
        id: REPORT_URL,
        action: "probe-open-report",
        title: "Open the report",
        children: [
          { kind: "text", text: "Report", face: "title" },
          { kind: "text", text: REPORT_URL, face: "helpLink" },
        ],
      },
    ],
    canvas: {
      aspect: Math.max(1.5, 12 / results.length),
      shapes: results.flatMap((result, index) => {
        const y = index * rowHeight
        return [
          {
            kind: "rect" as const,
            x: 0,
            y: y + rowHeight * 0.15,
            width: Math.max(0.01, result.seconds / slowest),
            height: rowHeight * 0.7,
            face: result.face,
          },
          {
            kind: "text" as const,
            x: 0.01,
            y: y + rowHeight * 0.72,
            text: `${result.name} (${result.seconds}s)`,
            face: "default",
          },
        ]
      }),
    },
  }
}

function targets() {
  const make = () => window.document.createElement("div") as unknown as HTMLElement
  const root = make()
  const built = { title: make(), windows: make(), minibuffer: make(), echo: make() }
  root.append(built.title, built.windows, built.minibuffer, built.echo)
  window.document.body.appendChild(root as never)
  return built
}

/** A serialized model whose single pane carries the report surface. */
function modelWithSurface(surface: WebSurfaceModel = reportSurface(), body = BODY) {
  defineMode({ name: MODE, parent: "text", webSurface: () => surface })
  const editor = makeEditor()
  const buffer = editor.scratch("*probe-test*", body, MODE, false)
  editor.switchToBuffer(buffer.id)
  return serializeDisplayModel(buildDisplayModel(editor, {
    viewport: { rows: 24, cols: 100 },
    hostCapabilities: { unit: "pixels", mouse: true, clipboard: true, osc52: false, richTables: true, webSurfaces: true },
  }))
}

afterEach(() => { modes.delete(MODE) })
beforeEach(() => { window.document.body.innerHTML = "" })

describe("web surface DOM renderer", () => {
  test("builds the element tree for a report surface", () => {
    const dom = targets()
    presentDomFrame(dom, modelWithSurface())

    const body = dom.windows.querySelector(".window-body")!
    expect(body.classList.contains("web-surface")).toBe(true)
    const root = body.querySelector(".web-surface-root")
    expect(root).not.toBeNull()

    const text = root!.textContent ?? ""
    expect(text).toContain(VERDICT)
    expect(text).toContain("ProbeTest.testRaises")
    expect(text).toContain(REPORT_URL)
  })

  test("emits a node per model kind, with faces resolved onto the elements", () => {
    const dom = targets()
    presentDomFrame(dom, modelWithSurface())
    const body = dom.windows.querySelector(".window-body")!

    expect(body.querySelectorAll(".web-node-row").length).toBeGreaterThan(0)
    expect(body.querySelectorAll(".web-node-text").length).toBeGreaterThan(0)
    // Every result row renders a bar.
    expect(body.querySelectorAll(".web-node-bar").length).toBe(4)
    expect(body.querySelectorAll(".web-node-bar-fill").length).toBe(4)

    // Faces are recorded on the element so the theme can be reapplied without a rebuild.
    // `NodeListOf` is not iterable under this lib target, so it is materialised first.
    const faces = Array.from(body.querySelectorAll("[data-face]"))
      .map(el => (el as HTMLElement).dataset.face)
    expect(faces).toContain("error")
    expect(faces).toContain("success")
    expect(faces).toContain("title")
  })

  test("bar widths are clamped percentages of the slowest row", () => {
    const dom = targets()
    presentDomFrame(dom, modelWithSurface())
    const widths = Array.from(dom.windows.querySelectorAll(".web-node-bar-fill"))
      .map(el => (el as HTMLElement).style.width)
    // testRaises is the slowest at 0.8s, so it fills completely; 0.4s is half.
    expect(widths).toContain("100%")
    expect(widths).toContain("50%")
    expect(widths.every(width => {
      const value = Number.parseFloat(width)
      return Number.isFinite(value) && value >= 0 && value <= 100
    })).toBe(true)
  })

  test("clicking a result row fires the rerun pane action with the row name", () => {
    const dom = targets()
    const fired: Array<{ windowId: string; action: string; payload?: Record<string, unknown> }> = []
    presentDomFrame(dom, modelWithSurface(), undefined, (windowId, action, payload) => {
      fired.push({ windowId, action, payload })
    })

    const row = dom.windows.querySelector('[data-node-id="ProbeTest.testRaises"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(row.classList.contains("web-node-clickable")).toBe(true)
    row.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as never)

    expect(fired).toHaveLength(1)
    expect(fired[0]!.action).toBe("probe-run-test")
    expect(fired[0]!.payload).toEqual({ id: "ProbeTest.testRaises" })
    expect(fired[0]!.windowId).toBeTruthy()
  })

  test("clicking the link row fires the open action with the URL", () => {
    const dom = targets()
    const fired: Array<{ action: string; payload?: Record<string, unknown> }> = []
    presentDomFrame(dom, modelWithSurface(), undefined, (_windowId, action, payload) => {
      fired.push({ action, payload })
    })

    const link = dom.windows.querySelector(`[data-node-id^="http://reports.test/"]`) as HTMLElement
    link.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as never)
    expect(fired[0]).toEqual({
      action: "probe-open-report",
      payload: { id: REPORT_URL },
    })
  })

  test("appends a canvas sized to the model's aspect ratio", () => {
    const dom = targets()
    presentDomFrame(dom, modelWithSurface())
    const canvas = dom.windows.querySelector("canvas.web-surface-canvas") as HTMLCanvasElement
    expect(canvas).not.toBeNull()
    expect(canvas.width).toBe(800)
    expect(canvas.height).toBeGreaterThan(0)
    // The backing store and the CSS box agree, so shapes are not distorted.
    expect(canvas.style.aspectRatio).toBe(`${canvas.width} / ${canvas.height}`)
  })

  test("tolerates a host whose canvas has no 2D context", () => {
    // happy-dom returns null from getContext("2d"); a renderer that assumed a context
    // would throw here and take the whole frame down with it.
    const dom = targets()
    expect(() => presentDomFrame(dom, modelWithSurface())).not.toThrow()
    expect(dom.windows.querySelector("canvas.web-surface-canvas")).not.toBeNull()
  })

  test("patching to a new surface swaps the rendered rows", () => {
    const dom = targets()
    presentDomFrame(dom, modelWithSurface())
    expect(dom.windows.textContent).toContain("ProbeTest.testRaises")

    // Same pane shape, different surface: this takes the patch path, not a full rebuild.
    modes.delete(MODE)
    const passing = reportSurface(
      [{ name: "UrpCoreSolveTest.testIntraMove", face: "success", label: "PASS", seconds: 0.5 }],
      "urp_core_solve_test PASSED - 1 passed (0.5s)",
    )
    presentDomFrame(dom, modelWithSurface(passing, "probe_test PASSED"))

    expect(dom.windows.textContent).toContain("UrpCoreSolveTest.testIntraMove")
    expect(dom.windows.textContent).not.toContain("ProbeTest.testRaises")
  })

  test("drives the 2D context once per shape when the host provides one", () => {
    // happy-dom has no canvas backend, so the drawing code is unreachable above. Stubbing
    // getContext is the only way to prove the shape loop itself runs and maps the model's
    // fractional coordinates onto the backing store.
    const calls: Array<{ op: string; args: number[] }> = []
    const context = {
      set fillStyle(_value: string) {},
      set strokeStyle(_value: string) {},
      set textAlign(_value: string) {},
      fillRect: (...args: number[]) => calls.push({ op: "fillRect", args }),
      strokeRect: (...args: number[]) => calls.push({ op: "strokeRect", args }),
      beginPath: () => calls.push({ op: "beginPath", args: [] }),
      moveTo: (...args: number[]) => calls.push({ op: "moveTo", args }),
      lineTo: (...args: number[]) => calls.push({ op: "lineTo", args }),
      stroke: () => calls.push({ op: "stroke", args: [] }),
      fillText: (text: string, x: number, y: number) => calls.push({ op: "fillText", args: [x, y] }),
    }
    const proto = window.HTMLCanvasElement.prototype as unknown as { getContext: unknown }
    const original = proto.getContext
    proto.getContext = () => context
    try {
      const dom = targets()
      presentDomFrame(dom, modelWithSurface())
      const canvas = dom.windows.querySelector("canvas.web-surface-canvas") as HTMLCanvasElement

      // The surface draws one bar plus one label per timed row (4 here).
      const rects = calls.filter(call => call.op === "fillRect")
      const labels = calls.filter(call => call.op === "fillText")
      expect(rects).toHaveLength(4)
      expect(labels).toHaveLength(4)

      // Fractional model coordinates are scaled onto the backing store, not passed raw.
      const widest = Math.max(...rects.map(call => call.args[2]!))
      expect(widest).toBe(canvas.width)
      expect(rects.every(call => call.args[1]! >= 0 && call.args[1]! + call.args[3]! <= canvas.height)).toBe(true)
      expect(labels.every(call => call.args[0]! >= 0 && call.args[0]! <= canvas.width)).toBe(true)
    } finally {
      proto.getContext = original
    }
  })

  test("draws every shape kind without throwing", () => {
    const ops: string[] = []
    const context = {
      set fillStyle(_value: string) {},
      set strokeStyle(_value: string) {},
      set textAlign(_value: string) {},
      fillRect: () => ops.push("fillRect"),
      strokeRect: () => ops.push("strokeRect"),
      beginPath: () => ops.push("beginPath"),
      moveTo: () => ops.push("moveTo"),
      lineTo: () => ops.push("lineTo"),
      stroke: () => ops.push("stroke"),
      fillText: () => ops.push("fillText"),
    }
    const proto = window.HTMLCanvasElement.prototype as unknown as { getContext: unknown }
    const original = proto.getContext
    proto.getContext = () => context
    try {
      const surface = {
        kind: "web" as const,
        nodes: [{ kind: "text" as const, text: "shapes" }],
        canvas: {
          aspect: 2,
          shapes: [
            { kind: "rect" as const, x: 0, y: 0, width: 0.5, height: 0.5, face: "success" },
            { kind: "rect" as const, x: 0.5, y: 0, width: 0.5, height: 0.5, fill: false },
            { kind: "line" as const, x1: 0, y1: 1, x2: 1, y2: 0, face: "error" },
            { kind: "text" as const, x: 0.5, y: 0.5, text: "centre", align: "center" as const },
          ],
        },
      }
      defineMode({ name: MODE, parent: "text", webSurface: () => surface })
      const editor = makeEditor()
      const buffer = editor.scratch("*shapes*", BODY, MODE, false)
      editor.switchToBuffer(buffer.id)
      const dom = targets()
      expect(() => presentDomFrame(dom, serializeDisplayModel(buildDisplayModel(editor, {
        viewport: { rows: 24, cols: 100 },
        hostCapabilities: { unit: "pixels", mouse: true, clipboard: true, osc52: false, richTables: true, webSurfaces: true },
      })))).not.toThrow()

      // Filled and outlined rects take different paths; a line is a stroked path.
      expect(ops).toEqual(["fillRect", "strokeRect", "beginPath", "moveTo", "lineTo", "stroke", "fillText"])
    } finally {
      proto.getContext = original
    }
  })

  test("a pane with no web surface renders plain body text instead", () => {
    const dom = targets()
    defineMode({ name: MODE, parent: "text", webSurface: () => null })
    const editor = makeEditor()
    const buffer = editor.scratch("*probe-test*", BODY, MODE, false)
    editor.switchToBuffer(buffer.id)
    presentDomFrame(dom, serializeDisplayModel(buildDisplayModel(editor, {
      viewport: { rows: 24, cols: 100 },
      hostCapabilities: { unit: "pixels", mouse: true, clipboard: true, osc52: false, richTables: true, webSurfaces: true },
    })))

    const body = dom.windows.querySelector(".window-body")!
    expect(body.classList.contains("web-surface")).toBe(false)
    expect(body.querySelector(".web-surface-root")).toBeNull()
    expect(body.textContent).toContain("ProbeTest.testRaises")
  })
})

/**
 * The node features the debugger panes rely on.
 *
 * A tree, a selection, and an enumerated value are what separate a debugger sidebar from
 * a flat list, and none of them survive a plain flex row: depth collapses, the pane paints
 * no caret, and a short value disappears into the text around it.
 */
describe("web surface tree and selection", () => {
  const surface = {
    kind: "web" as const,
    nodes: [
      { kind: "row" as const, id: "0", children: [{ kind: "text" as const, text: "Locals", face: "title" }] },
      {
        kind: "row" as const,
        id: "1",
        indent: 2,
        selected: true,
        action: "dap-activate",
        title: "Expand config",
        children: [
          { kind: "text" as const, text: "▸", face: "keyword" },
          { kind: "text" as const, text: "config" },
          { kind: "badge" as const, text: "dict", face: "keyword" },
        ],
      },
    ],
  }

  function render() {
    defineMode({ name: MODE, parent: "text", webSurface: () => surface })
    const editor = makeEditor()
    const buffer = editor.scratch("*dap-ui-locals*", ["Locals", "    ▸ config [dict]"].join(NL), MODE, false)
    editor.switchToBuffer(buffer.id)
    const dom = targets()
    presentDomFrame(dom, serializeDisplayModel(buildDisplayModel(editor, {
      viewport: { rows: 24, cols: 100 },
      hostCapabilities: { unit: "pixels", mouse: true, clipboard: true, osc52: false, richTables: true, webSurfaces: true },
    })))
    return dom
  }

  test("indents a nested row in ch, so it aligns with the same tree in text", () => {
    const rows = Array.from(render().windows.querySelectorAll(".web-node-row"))
    expect((rows[0] as HTMLElement).style.marginLeft).toBe("")
    // Two columns per level, matching the two-space indent of the body text.
    expect((rows[1] as HTMLElement).style.marginLeft).toBe("4ch")
  })

  test("marks the selected row, which is the pane's only cursor", () => {
    const dom = render()
    const selected = Array.from(dom.windows.querySelectorAll(".web-node-selected"))
    expect(selected).toHaveLength(1)
    expect((selected[0] as HTMLElement).dataset.nodeId).toBe("1")
  })

  test("renders a badge as its own element carrying its face", () => {
    const badge = render().windows.querySelector(".web-node-badge") as HTMLElement
    expect(badge).not.toBeNull()
    expect(badge.textContent).toBe("dict")
    expect(badge.dataset.face).toBe("keyword")
  })

  test("a click on a tree row reports the row id the mode indexes by", () => {
    const dom = targets()
    const fired: Array<{ action: string; payload?: Record<string, unknown> }> = []
    defineMode({ name: MODE, parent: "text", webSurface: () => surface })
    const editor = makeEditor()
    const buffer = editor.scratch("*dap-ui-locals*", ["Locals", "    ▸ config [dict]"].join(NL), MODE, false)
    editor.switchToBuffer(buffer.id)
    presentDomFrame(dom, serializeDisplayModel(buildDisplayModel(editor, {
      viewport: { rows: 24, cols: 100 },
      hostCapabilities: { unit: "pixels", mouse: true, clipboard: true, osc52: false, richTables: true, webSurfaces: true },
    })), undefined, (_windowId, action, payload) => { fired.push({ action, payload }) })

    const row = dom.windows.querySelector('[data-node-id="1"]') as HTMLElement
    expect(row.title).toBe("Expand config")
    row.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as never)
    expect(fired).toEqual([{ action: "dap-activate", payload: { id: "1" } }])

    // The heading has no action, so clicking it must not dispatch anything.
    ;(dom.windows.querySelector('[data-node-id="0"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as never)
    expect(fired).toHaveLength(1)
  })
})

describe("canvas repaint stability", () => {
  const CANVAS_MODE = "flicker-probe-mode"

  /**
   * One editor across frames, as a real animating buffer has.
   *
   * `frame(offset)` re-serializes the same window with new geometry, which is exactly
   * what the animation timer produces.
   */
  function canvasHarness(withCanvas = true) {
    let offset = 0
    defineMode({
      name: CANVAS_MODE,
      parent: "text",
      // Omit `canvas` entirely rather than setting it undefined: the field is optional,
      // so an explicit undefined does not satisfy the surface type.
      webSurface: () => (withCanvas
        ? {
            kind: "web" as const,
            nodes: [{ kind: "text" as const, text: "frame" }],
            canvas: { aspect: 2, shapes: [{ kind: "line" as const, x1: 0.1 + offset, y1: 0.5, x2: 0.9, y2: 0.5 }] },
          }
        : {
            kind: "web" as const,
            nodes: [{ kind: "text" as const, text: "frame" }],
          }),
    })
    const editor = makeEditor()
    const buffer = editor.scratch("*canvas*", "frame", CANVAS_MODE, false)
    editor.switchToBuffer(buffer.id)
    return (next: number) => {
      offset = next
      return serializeDisplayModel(buildDisplayModel(editor, {
        viewport: { rows: 24, cols: 100 },
        hostCapabilities: {
          unit: "pixels", mouse: true, clipboard: true,
          osc52: false, richTables: true, webSurfaces: true,
        },
      }))
    }
  }

  afterEach(() => { modes.delete(CANVAS_MODE) })

  test("reuses the same canvas element across repaints", () => {
    const dom = targets()
    const frame = canvasHarness()
    presentDomFrame(dom, frame(0))
    const first = dom.windows.querySelector("canvas.web-surface-canvas")
    expect(first).not.toBeNull()

    presentDomFrame(dom, frame(0.1))
    const second = dom.windows.querySelector("canvas.web-surface-canvas")

    // Node identity is the whole point: recreating the element each frame is what made
    // the pane flash between the canvas and an empty body during animation.
    expect(second === first).toBe(true)
  })

  test("does not accumulate canvas elements", () => {
    const dom = targets()
    const frame = canvasHarness()
    for (let i = 0; i < 5; i++) presentDomFrame(dom, frame(i * 0.05))
    expect(dom.windows.querySelectorAll("canvas.web-surface-canvas")).toHaveLength(1)
    expect(dom.windows.querySelectorAll(".web-surface-root")).toHaveLength(1)
  })

  test("renders no canvas when the surface does not provide one", () => {
    const dom = targets()
    const frame = canvasHarness(false)
    presentDomFrame(dom, frame(0))
    expect(dom.windows.querySelector("canvas.web-surface-canvas")).toBeNull()
    // The node tree still renders.
    expect(dom.windows.querySelectorAll(".web-surface-root")).toHaveLength(1)
  })
})

/**
 * `image` nodes, which `image-mode` uses to show a picture file in the GUI.
 *
 * A surface is built from buffer contents, so `src` is filtered: only local files and
 * inline data reach an <img>. Everything else must degrade to text rather than make the
 * frame fetch a URL an opened file chose.
 */
describe("web surface image nodes", () => {
  const IMAGE_MODE = "web-surface-image-probe"

  function paint(src: string | undefined, text?: string) {
    modes.delete(IMAGE_MODE)
    defineMode({
      name: IMAGE_MODE,
      parent: "text",
      webSurface: () => ({ kind: "web" as const, nodes: [{ kind: "image" as const, src, text }] }),
    })
    const editor = makeEditor()
    const buffer = editor.scratch("*image*", "pixel.png", IMAGE_MODE, false)
    editor.switchToBuffer(buffer.id)
    const dom = targets()
    presentDomFrame(dom, serializeDisplayModel(buildDisplayModel(editor, {
      viewport: { rows: 24, cols: 100 },
      hostCapabilities: { unit: "pixels", mouse: true, clipboard: true, osc52: false, richTables: true, webSurfaces: true },
    })))
    return dom
  }

  afterEach(() => { modes.delete(IMAGE_MODE) })

  test("draws an <img> for a file: URL", () => {
    const dom = paint("file:///tmp/pixel.png", "pixel.png")
    const img = dom.windows.querySelector("img.web-node-image") as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute("src")).toBe("file:///tmp/pixel.png")
    expect(img.getAttribute("alt")).toBe("pixel.png")
  })

  test("draws an <img> for an inline data: URL", () => {
    const dom = paint("data:image/png;base64,iVBORw0KGgo=")
    expect(dom.windows.querySelector("img.web-node-image")).not.toBeNull()
  })

  test("refuses any other scheme and shows text instead", () => {
    for (const src of ["http://example.com/a.png", "https://example.com/a.png", "javascript:alert(1)", undefined]) {
      const dom = paint(src, "blocked")
      expect(dom.windows.querySelector("img.web-node-image")).toBeNull()
      expect(dom.windows.textContent).toContain("blocked")
    }
  })
})
