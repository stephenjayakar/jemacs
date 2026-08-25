/**
 * The text body must be patched, not rebuilt, when the cursor moves.
 *
 * `renderBodyRows` used to end in `el.replaceChildren(...rows)`, discarding and
 * recreating every `.body-row` on every frame. Two things then conspire:
 *
 *   - `patchPane` falls back to a full `fillPane` whenever the body *and* the modeline
 *     both change, and a modeline shows line:col, so every cursor movement takes that
 *     path.
 *   - Even the non-teardown path called `renderBodyRows`, which replaced the subtree
 *     anyway.
 *
 * So scrolling through a document destroyed and re-laid-out every visible line on every
 * keystroke. Markdown is the worst case: the default face is remapped to variable pitch
 * and headings are height-scaled, so each rebuild is a full font reflow -- which the user
 * sees as flicker, and which is worst near the end of a large file where the viewport
 * correction also fires.
 *
 * These tests pin node identity: rows whose content did not change must be the *same*
 * elements across frames.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Window } from "happy-dom"

const window = new Window({ url: "http://localhost" })
const globals = globalThis as Record<string, unknown>
globals.window = window
globals.document = window.document
globals.HTMLElement = window.HTMLElement
globals.HTMLCanvasElement = window.HTMLCanvasElement
globals.requestAnimationFrame = (callback: FrameRequestCallback) => { void callback(0); return 0 }
globals.cancelAnimationFrame = () => {}

const { presentDomFrame, renderBodyRows } = await import("../../src/display/dom-frame")
const { serializeDisplayModel } = await import("../../src/display/serialize")
const { buildDisplayModel } = await import("../../src/display/build-display-model")
const { install: installMarkdown } = await import("../../plugins/markdown")
const { makeEditor } = await import("../plugins/helper")
const { modes } = await import("../../src/modes/mode")

const NL = String.fromCharCode(10)

const CAPS = {
  unit: "pixels" as const,
  mouse: true,
  clipboard: true,
  osc52: false,
  richTables: true,
  webSurfaces: true,
  perFaceFonts: true,
}

function targets() {
  const make = () => window.document.createElement("div") as unknown as HTMLElement
  const root = make()
  const built = { title: make(), windows: make(), minibuffer: make(), echo: make() }
  root.append(built.title, built.windows, built.minibuffer, built.echo)
  window.document.body.appendChild(root as never)
  return built
}

function bodyEl(): HTMLElement {
  const el = window.document.createElement("div") as unknown as HTMLElement
  el.className = "window-body"
  window.document.body.appendChild(el as never)
  return el
}

/** Themed text of `n` numbered lines. */
function lines(n: number, tag = "line") {
  return { chunks: [{ text: Array.from({ length: n }, (_, i) => `${tag} ${i}`).join(NL) }] }
}

function markdownEditor(sections: number) {
  const editor = makeEditor()
  installMarkdown(editor)
  const out: string[] = []
  for (let i = 0; i < sections; i++) {
    out.push(`# Heading ${i}`)
    out.push("")
    out.push(`Prose paragraph ${i}. ` + "word ".repeat(18).trim())
    out.push("")
  }
  const buffer = editor.scratch("big.md", out.join(NL), "markdown")
  editor.switchToBuffer(buffer.id)
  return { editor, buffer }
}

beforeEach(() => { window.document.body.innerHTML = "" })
afterEach(() => { modes.delete("markdown") })

describe("body rows are reconciled, not rebuilt", () => {
  test("identical content reuses every row element", () => {
    const el = bodyEl()
    const first = [...renderBodyRows(el, lines(30) as never)]
    const second = [...renderBodyRows(el, lines(30) as never)]
    // Compare identity per element. `toEqual` on DOM nodes walks parent/child
    // back-references and is pathologically slow when the nodes actually differ.
    expect(second).toHaveLength(first.length)
    const recreated = second.filter((row, i) => row !== first[i]).length
    expect(recreated).toBe(0)
  })

  test("changing one line leaves the other rows untouched", () => {
    const el = bodyEl()
    const before = [...renderBodyRows(el, lines(20) as never)]

    const edited = lines(20)
    const text = edited.chunks[0]!.text.split(NL)
    text[7] = "line 7 EDITED"
    const after = [...renderBodyRows(el, { chunks: [{ text: text.join(NL) }] } as never)]

    expect(after).toHaveLength(before.length)
    // Same element objects either way -- only row 7's contents were swapped.
    const moved = after.filter((row, i) => row !== before[i]).length
    expect(moved).toBe(0)
    expect(after[7]!.textContent).toBe("line 7 EDITED")
    expect(after[6]!.textContent).toBe("line 6")
  })

  test("shrinking the content drops the surplus rows", () => {
    const el = bodyEl()
    renderBodyRows(el, lines(20) as never)
    const after = renderBodyRows(el, lines(5) as never)
    expect(after).toHaveLength(5)
    expect(el.querySelectorAll(".body-row")).toHaveLength(5)
  })

  test("growing the content keeps the existing rows and appends", () => {
    const el = bodyEl()
    const before = [...renderBodyRows(el, lines(5) as never)]
    const after = [...renderBodyRows(el, lines(9) as never)]
    expect(after).toHaveLength(9)
    const displaced = before.filter((row, i) => row !== after[i]).length
    expect(displaced).toBe(0)
  })

  test("a caret left by a previous frame does not survive as a stray child", () => {
    const el = bodyEl()
    renderBodyRows(el, lines(10) as never)
    const caret = window.document.createElement("div")
    caret.className = "jemacs-caret"
    el.appendChild(caret as never)

    renderBodyRows(el, lines(10) as never)
    expect(el.querySelectorAll(".jemacs-caret")).toHaveLength(0)
    expect(el.querySelectorAll(".body-row")).toHaveLength(10)
  })

  /** The reported scenario, end to end through the real renderer. */
  test("markdown near EOF reuses rows as the cursor moves", () => {
    const dom = targets()
    const { editor, buffer } = markdownEditor(200)
    const total = buffer.text.split(NL).length

    const frame = () => serializeDisplayModel(buildDisplayModel(editor, {
      lastMessage: "",
      viewport: { rows: 30, cols: 100 },
      hostCapabilities: CAPS,
    }))

    let line = total - 20
    buffer.point = buffer.lineStarts[line] ?? buffer.text.length
    presentDomFrame(dom, frame())

    let reused = 0
    let recreated = 0
    for (let step = 0; step < 12; step++) {
      const body = dom.windows.querySelector(".window-body")!
      const before = new Set(Array.from(body.querySelectorAll(".body-row")))

      line = Math.min(total - 1, line + 1)
      buffer.point = buffer.lineStarts[line] ?? buffer.text.length
      presentDomFrame(dom, frame())

      for (const row of Array.from(body.querySelectorAll(".body-row"))) {
        if (before.has(row)) reused++
        else recreated++
      }
    }

    // Before the fix this was reused=0, recreated=255: the whole visible document
    // thrown away and rebuilt on every single cursor move.
    expect(reused).toBeGreaterThan(0)
    expect(recreated).toBeLessThan(reused / 10)
  })
})
