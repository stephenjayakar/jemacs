import type { Editor } from "./kernel/editor"
import { findWindowLeaf } from "./kernel/window"
import { buildDisplayModel } from "./display/build-display-model"
import { pointFromWindowClick } from "./display/click-to-point"
import { findPaneInModel } from "./display/find-pane"
import type { DisplayModel, InputHandler, UiHost } from "./display/protocol"

export type JemacsHostBinding = {
  present: () => void
  onInput: InputHandler
}

/** Wire editor state, input, and redisplay to a host (shared by TUI, GUI, and tests). */
export function bindJemacsHost(editor: Editor, host: UiHost): JemacsHostBinding {
  let lastMessage = ""
  let lastModel!: DisplayModel

  editor.events.on("message", ({ text }) => {
    lastMessage = text
  })

  const present = () => {
    const viewport = host.getViewport()
    lastModel = buildDisplayModel(editor, {
      lastMessage,
      viewport,
      hostLabel: host.label,
      hostCapabilities: host.capabilities,
    })
    host.present(lastModel)
  }

  const onInput: InputHandler = async input => {
    try {
      if (input.type === "key") {
        await editor.handleKey(input.key)
      } else if (input.type === "paste") {
        // Plugins (e.g. jterm) can install a per-buffer paste handler via
        // `buffer.locals.set("paste-handler", fn)`; returning truthy means the
        // handler consumed the paste and the default buffer.insert is skipped.
        const buf = editor.activeBuffer
        const handler = buf.locals.get("paste-handler") as ((text: string) => unknown) | undefined
        if (handler) {
          await handler(input.text)
        } else {
          buf.insert(input.text)
          await editor.changed("paste")
        }
      } else if (input.type === "mouse") {
        const pane = findPaneInModel(lastModel.windows, input.windowId)
        const leaf = findWindowLeaf(editor.windowLayout, input.windowId)
        const buffer = leaf && editor.buffers.get(leaf.bufferId)
        if (pane && buffer) {
          const point = pointFromWindowClick(buffer.text, pane.clickState, input.row, input.col, pane.bodyLineBudget)
          editor.clickWindow(input.windowId, point)
        }
      }
    } catch (error) {
      editor.message(error instanceof Error ? error.message : String(error))
      if (error instanceof Error && error.stack) {
        const log = [...editor.buffers.values()].find(b => b.name === "*messages*")
        log?.append(`${error.stack}\n`)
      }
    }
  }

  return { present, onInput }
}

/** Host bootstrap without OpenTUI-specific wiring (safe for Electron main bundle). */
export async function runJemacsCore(editor: Editor, host: UiHost): Promise<JemacsHostBinding> {
  await host.start()

  const binding = bindJemacsHost(editor, host)

  host.onInput(binding.onInput)
  host.onResize(() => binding.present())
  editor.events.on("terminalData", payload => {
    host.sendTerminalData?.(payload)
  })

  let scheduled = false
  editor.events.on("changed", () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      binding.present()
      if (!editor.running) host.destroy()
    })
  })

  binding.present()
  return binding
}
