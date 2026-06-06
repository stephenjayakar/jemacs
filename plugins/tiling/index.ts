import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defvar, getCustom, setCustom } from "../../src/runtime/custom"

const LAYOUTS = ["tiling-master-left", "tiling-master-top", "tiling-even-horizontal", "tiling-even-vertical", "tiling-tile-4"] as const

defvar("tiling-layout", "tiling-master-left",
  "Current i3-style tiling layout name. Hosts that implement automatic tiling read this.")

export function tilingLayout(): string {
  return getCustom("tiling-layout") as string
}

export function cycleTilingLayout(editor: Editor): string {
  const cur = tilingLayout()
  const next = LAYOUTS[(LAYOUTS.indexOf(cur as typeof LAYOUTS[number]) + 1) % LAYOUTS.length]!
  setCustom("tiling-layout", next)
  void editor.changed("tiling-cycle")
  return next
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  editor.command("tiling-cycle", ({ editor }) => editor.message(`Layout ${cycleTilingLayout(editor)}`),
    "Cycle i3-style tiling layouts (state in `tiling-layout` defvar; hosts opt in to render it).")
  editor.key("C-\\", "tiling-cycle")
}
