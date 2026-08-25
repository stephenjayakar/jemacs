import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defineMode, modes, type WebSurfaceModel } from "../../src/modes/mode"
import { Keymap } from "../../src/kernel/keymap"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { renderHtml } from "./render"
import { HTML_DEMOS, htmlDemoIndexText } from "./demos"

/**
 * `html-render-mode`: view an HTML buffer as a laid-out document in the GUI.
 *
 * This is a *rendering* mode, kept separate from the existing `html` editing mode so that
 * opening a .html file still gives you syntax-highlighted source. `M-x html-render`
 * toggles between the two.
 */

defcustom(
  "html-render-max-nodes",
  "number",
  2000,
  "Stop laying out an HTML document after this many surface nodes.",
)

/** Buffer-local flag marking a buffer as showing rendered output. */
const RENDERED = "html-rendered"

function htmlSurface(buffer: BufferModel): WebSurfaceModel | null {
  const { nodes } = renderHtml(buffer.text)
  const limit = Math.max(1, getCustom<number>("html-render-max-nodes") ?? 2000)
  const truncated = nodes.length > limit
  const shown = truncated ? nodes.slice(0, limit) : nodes
  if (truncated) {
    shown.push({
      kind: "text",
      face: "comment",
      text: `… ${nodes.length - limit} more nodes not shown (html-render-max-nodes)`,
    })
  }
  return { kind: "web", nodes: shown }
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const keymap = new Keymap("html-render-mode-map")
  keymap.bind("C-c C-r", "html-render")
  keymap.bind("q", "html-render")

  defineMode({
    name: "html-render",
    parent: "text",
    keymap,
    webSurface: htmlSurface,
  })

  // The existing tree-sitter `html` mode stays the editing mode; give it the toggle key
  // so C-c C-r flips source -> rendered and back.
  if (modes.get("html")) {
    ctx.key("html-map", "C-c C-r", "html-render")
  }

  ctx.command("html-render", ({ editor, buffer }) => {
    if (buffer.locals.get(RENDERED)) {
      buffer.locals.delete(RENDERED)
      editor.enterMode(buffer, "html")
      editor.message("html: showing source")
      return
    }
    buffer.locals.set(RENDERED, true)
    editor.enterMode(buffer, "html-render")
    const { nodes } = renderHtml(buffer.text)
    editor.message(`html: rendered ${nodes.length} blocks (C-c C-r for source)`)
  }, "Toggle between HTML source and the rendered document.")

  ctx.command("html-render-mode", ({ editor, buffer }) => {
    buffer.locals.set(RENDERED, true)
    editor.enterMode(buffer, "html-render")
  }, "Render the current buffer as an HTML document (GUI only).")

  ctx.command("html-render-to-text", ({ editor, buffer }) => {
    // The plain-text projection is useful on its own: it is what the TUI shows, and it
    // makes the rendering diffable and testable.
    const { text } = renderHtml(buffer.text)
    editor.scratch(`*html text: ${buffer.name}*`, text || "(empty document)", "text")
  }, "Show the plain-text rendering of the current HTML buffer.")

  ctx.command("html-demo", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("HTML demo: ", {
      collection: HTML_DEMOS.map(demo => demo.name),
    })
    if (!name) return
    const demo = HTML_DEMOS.find(d => d.name === name)
    if (!demo) {
      editor.message(`No such HTML demo: ${name}`)
      return
    }
    const buffer = editor.scratch(`*html: ${demo.name}*`, demo.source, "html-render")
    buffer.locals.set(RENDERED, true)
    editor.message(`${demo.name} — ${demo.description} (C-c C-r for source)`)
  }, "Open one of the built-in HTML demos.")

  ctx.command("html-demos", ({ editor }) => {
    editor.scratch("*html demos*", htmlDemoIndexText(), "text")
  }, "List the built-in HTML demos.")
}
