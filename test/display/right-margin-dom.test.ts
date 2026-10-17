/**
 * Right-margin notes in the DOM renderer: a row's margin chunks share one
 * pinned `.margin-note` box, and a mousedown on a clickable cell reports a
 * `right-margin-click` pane action instead of moving point.
 */
import { expect, test } from "bun:test"
import { Window } from "happy-dom"

const window = new Window({ url: "http://localhost" })
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
const { install: installMarkdown } = await import("../../plugins/markdown")
const { install: installCritique, CRITIQUE_MODE } = await import("../../plugins/critique")
const { makeEditor } = await import("../plugins/helper")

const CAPS = { unit: "pixels" as const, mouse: true, clipboard: true, osc52: false, perFaceFonts: true }

test("margin note renders as one box with clickable cells that report pane actions", () => {
  const editor = makeEditor()
  installMarkdown(editor)
  installCritique(editor)
  const buffer = editor.scratch("doc.md", "The ==fox==%%too **quick**%% runs.\n", "markdown")
  editor.enableMinorMode(CRITIQUE_MODE, { buffer })

  const make = () => window.document.createElement("div") as unknown as HTMLElement
  const dom = { title: make(), windows: make(), minibuffer: make(), echo: make() }
  for (const el of Object.values(dom)) window.document.body.appendChild(el as never)
  const actions: Array<[string, string, unknown]> = []
  const clicks: unknown[] = []
  const model = serializeDisplayModel(buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 20, cols: 100 }, hostCapabilities: CAPS }))
  presentDomFrame(dom, model, (...args) => clicks.push(args), (windowId, action, payload) => actions.push([windowId, action, payload]))

  const notes = dom.windows.querySelectorAll(".margin-note")
  expect(notes).toHaveLength(1)
  const cells = [...notes[0]!.querySelectorAll<HTMLElement>(".margin-action")]
  expect(cells.map(c => c.dataset.marginAction)).toEqual(["edit", "resolve", "reply"])
  expect(cells[0]!.textContent).toContain("too quick")
  // Styled runs of the note's text stay inside the one edit cell.
  const runs = Array.from(cells[0]!.querySelectorAll("span")) as HTMLElement[]
  expect(runs.find(r => r.textContent === "quick")?.style.fontWeight).toBe("bold")

  cells[1]!.dispatchEvent(new window.MouseEvent("mousedown", { button: 0, bubbles: true }) as never)
  expect(actions).toEqual([[editor.selectedWindowId, "right-margin-click", { note: cells[1]!.dataset.marginNote, action: "resolve" }]])
  expect(clicks).toEqual([])
})
