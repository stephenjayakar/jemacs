import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { CommandContext } from "../../src/kernel/command"
import { defcustom } from "../../src/runtime/custom"

/** Build the OSC 52 clipboard-set sequence for `text`. */
export function osc52Encode(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64")
  return `\x1b]52;c;${b64}\x07`
}

const enabled = defcustom("osc52-enabled", "boolean", true,
  "If non-nil, every kill also writes an OSC 52 sequence to the host terminal's clipboard.")

/** UiHost has no writeRaw; bypass it and write straight to the PTY when we have one. */
function emit(text: string): void {
  if (!text || !enabled.value) return
  if (!process.stdout.isTTY) return
  process.stdout.write(osc52Encode(text))
}

/** Destructive kills all bottom out in `deleteRange`, which leaves point at the
 *  removed span's start — so the killed text is recoverable from a before/after
 *  diff without needing access to the (closure-captured) kill ring. */
function adviseDestructive(ctx: PluginContext, name: string): void {
  let beforeText = ""
  ctx.advice(name, {
    before: ({ buffer }) => { beforeText = buffer.text },
    after: ({ buffer }) => {
      const delta = beforeText.length - buffer.text.length
      if (delta > 0) emit(beforeText.slice(buffer.point, buffer.point + delta))
    },
  })
}

/** kill-ring-save doesn't mutate the buffer; recompute its copy target. */
function copyRegionAfter({ buffer }: CommandContext): void {
  const selected = buffer.selectedText()
  if (selected) return emit(selected)
  const line = buffer.lineBoundsAt()
  emit(line.text + (line.end < buffer.text.length ? "\n" : ""))
}

export function install(_editor: Editor, ctx: PluginContext = createPluginContext(_editor)): void {
  for (const name of ["kill-region", "kill-line", "kill-word", "backward-kill-word"]) {
    adviseDestructive(ctx, name)
  }
  ctx.advice("kill-ring-save", { after: copyRegionAfter })
}
