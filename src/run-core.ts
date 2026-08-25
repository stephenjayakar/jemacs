import type { Editor } from "./kernel/editor"
import { findWindowLeaf } from "./kernel/window"
import { buildDisplayModel } from "./display/build-display-model"
import { pointFromWindowClick } from "./display/click-to-point"
import { findPaneInModel } from "./display/find-pane"
import type { DisplayModel, InputHandler, UiHost } from "./display/protocol"
import { scrollWindowByLines } from "./display/scroll"
import { modeSystem } from "./kernel/extension-points"
import { tabBarHitTest } from "./display/tab-bar"

export type JemacsHostBinding = {
  present: () => void
  /**
   * Build the model for one frame using the *same* options `present` uses.
   *
   * Multi-frame hosts paint each OS window separately, but they must not build
   * their own options: `buildDisplayModel` persists a corrected `startLine`
   * back onto the window as a side effect, and that correction depends on
   * `hostCapabilities` (`perFaceFonts` selects font-metric row costs over unit
   * rows). Two callers passing different capabilities write different
   * corrections on alternate frames and the pane oscillates. Capabilities also
   * gate `webSurface`, so a caller that omits them drops canvas/HTML panes to
   * their plain-text fallback every other frame.
   */
  modelFor: (frameId?: string) => DisplayModel
  onInput: InputHandler
}

/** Wire editor state, input, and redisplay to a host (shared by TUI, GUI, and tests). */
export function bindJemacsHost(editor: Editor, host: UiHost): JemacsHostBinding {
  let lastMessage = ""
  let lastModel!: DisplayModel

  editor.events.on("message", ({ text }) => {
    lastMessage = text
  })

  const modelFor = (frameId?: string): DisplayModel => {
    const model = buildDisplayModel(editor, {
      lastMessage,
      viewport: host.getViewport(),
      hostLabel: host.label,
      hostCapabilities: host.capabilities,
      frameId,
    })
    // `onInput` maps clicks through `pane.clickState`, which only exists on a built
    // model. Recording here rather than in `present` keeps that mapping available to
    // multi-frame hosts, which never call `present` at all. Frames other than the
    // selected one cannot receive input without first being focused (the host reports
    // the originating frame, and `onInput` selects it), so the last frame built is a
    // safe source for the panes any subsequent event can name.
    lastModel = model
    return model
  }

  const present = () => {
    host.present(modelFor())
  }

  const onInput: InputHandler = async (input, frameId) => {
    // Multi-frame hosts report which frame the event came from; focusing it
    // first makes every command act on the frame the user actually typed into.
    if (frameId) editor.selectFrame(frameId)
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
          editor.clickWindow(input.windowId, point, input.drag === true)
        }
      } else if (input.type === "wheel") {
        const leaf = findWindowLeaf(editor.windowLayout, input.windowId)
        if (leaf) {
          editor.selectWindow(input.windowId)
          const requestedLines = Number.isFinite(input.lines) ? Math.trunc(input.lines) : 1
          scrollWindowByLines(editor, requestedLines)
          await editor.changed("wheel-scroll")
        }
      } else if (input.type === "tab-bar") {
        // Emacs's tab bar is a keymap of clickable items; the hit test names
        // which item was pressed and each maps to the command Emacs binds.
        const hit = tabBarHitTest(editor, input.col)
        if (hit?.kind === "select") await editor.run("tab-bar-select-tab", [String(hit.index + 1)])
        else if (hit?.kind === "close") await editor.run("tab-bar-close-tab", [String(hit.index + 1)])
        else if (hit?.kind === "new") await editor.run("tab-bar-new-tab")
      } else if (input.type === "pane-action") {
        const leaf = findWindowLeaf(editor.windowLayout, input.windowId)
        const buffer = leaf && editor.buffers.get(leaf.bufferId)
        if (buffer) {
          editor.selectWindow(input.windowId)
          const handled = modeSystem.modeFeature(buffer.mode, "paneAction")?.(buffer, {
            action: input.action,
            payload: input.payload,
          })
          if (handled) await editor.changed(`pane-action:${input.action}`)
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

  return { present, modelFor, onInput }
}

/** Host bootstrap without OpenTUI-specific wiring (safe for Electron main bundle). */
export async function runJemacsCore(editor: Editor, host: UiHost): Promise<JemacsHostBinding> {
  await host.start()

  const binding = bindJemacsHost(editor, host)

  // One redisplay must paint each frame exactly once. A multi-frame host paints
  // through `syncFrames`, which already covers the selected frame, so calling
  // `present` as well would build a second model for the same window. Both
  // builds persist a corrected `startLine` as a side effect, so two builds per
  // redisplay let the window settle on a different scroll position on alternate
  // frames -- flicker with no user input.
  const redisplay = host.syncFrames
    ? () => host.syncFrames!(editor.frames, binding.modelFor)
    : binding.present

  host.onInput(binding.onInput)
  host.onResize(redisplay)
  editor.events.on("terminalData", payload => {
    host.sendTerminalData?.(payload)
  })

  let scheduled = false
  editor.events.on("changed", () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      redisplay()
      if (!editor.running) host.destroy()
    })
  })

  redisplay()
  return binding
}
