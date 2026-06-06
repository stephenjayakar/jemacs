import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import type { FaceName, TextSpan } from "../../src/modes/mode"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defface } from "../../src/runtime/faces"
import { defvar } from "../../src/runtime/custom"
import { transformSplice, type Splice } from "../../src/shadow/ops"
import { attachAuthority, attachShadow, authorityState, shadowState } from "../../src/shadow/shadow"
import { parseConnectTarget, spawnStdioLink } from "../../src/shadow/stdio-link"
import { connectWs, serveShadow, type ServeShadowResult } from "../../src/shadow/ws-link"

/** buffer.locals key written by attachShadow (shadow.ts mirrors ShadowState.pending here). */
export const SHADOW_PENDING_LOCAL = "shadow-pending"

// FaceName is a closed union; defface registers the spec, the cast lets it ride a TextSpan.
export const SHADOW_PENDING_FACE = "shadow-pending" as FaceName

/**
 * Overlay spans for not-yet-ack'd splices (DESIGN.md §Speculative rendering).
 *
 * Each pending op's `from`/`to` are positions at the time it was applied; the
 * inserted text occupied `[from, from + text.length)` then. Later pending ops
 * have since shifted those offsets, so each span is transformed past every
 * subsequent op via the same offset-shift used in rebase. A span that overlaps
 * a later op (its text was edited again) is dropped — the later op's span
 * covers the surviving bytes.
 */
export function shadowPendingSpans(buffer: BufferModel): TextSpan[] {
  const pending = buffer.locals.get(SHADOW_PENDING_LOCAL) as Splice[] | undefined
  if (!pending?.length) return []
  const spans: TextSpan[] = []
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i]!
    let range: Splice | null = { ...p, to: p.from + p.text.length }
    for (let j = i + 1; j < pending.length && range; j++) {
      range = transformSplice(range, pending[j]!)
    }
    if (range && range.from < range.to) {
      spans.push({ start: range.from, end: range.to, face: SHADOW_PENDING_FACE })
    }
  }
  return spans
}

/** Modeline segment: `[⊘ partition]` / `[⇅ N]` / `[✓]`; empty for non-remote buffers. */
export function shadowModeLighter(buffer: BufferModel): string {
  if (!buffer.link) return ""
  if ((buffer.link as { partitioned?: boolean }).partitioned) return " [⊘ partition]"
  const pending = buffer.locals.get(SHADOW_PENDING_LOCAL) as Splice[] | undefined
  const n = pending?.length ?? 0
  return n > 0 ? ` [⇅ ${n}]` : " [✓]"
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defface("shadow-pending", { fg: "#888888", italic: true },
    "Face for text sent to the authority but not yet acknowledged.", "shadow")

  editor.addOverlaySource(shadowPendingSpans)

  // build-display-model concats every fn in this list onto the lighters string.
  const misc = defvar("mode-line-misc-info", [] as Array<(b: BufferModel) => string>).value
  if (!misc.includes(shadowModeLighter)) misc.push(shadowModeLighter)
  ctx.onDispose(() => {
    const i = misc.indexOf(shadowModeLighter)
    if (i >= 0) misc.splice(i, 1)
  })

  ctx.command("shadow-connect", async ({ editor, args }) => {
    const target = args[0] ?? await editor.prompt("Connect to (ssh://host, ws://host:port/?token=…, or stdio:CMD): ", "", "shadow-connect")
    if (!target) return
    if (shadowState(editor)) {
      editor.message("[shadow] already connected; M-x shadow-disconnect first")
      return
    }
    const onClose = () => editor.message(`[shadow] disconnected from ${target}`)
    // ws:// routes to WsLink; everything else falls through to the stdio/ssh parser.
    const link = target.startsWith("ws://")
      ? connectWs(target, { onClose })
      : spawnStdioLink(parseConnectTarget(target), { onClose })
    attachShadow(editor, link, ctx)
    editor.message(`[shadow] connected to ${target}`)
  }, "Attach this editor as a shadow of a remote authority over ssh://, ws://, or stdio:.")

  ctx.command("shadow-disconnect", ({ editor }) => {
    const state = shadowState(editor)
    if (!state) { editor.message("[shadow] not connected"); return }
    state.link.close()
  }, "Close the active shadow link.")

  let serving: ServeShadowResult | undefined
  ctx.command("shadow-serve", ({ editor }) => {
    if (serving || authorityState(editor)) {
      editor.message("[shadow] already serving; M-x shadow-stop-server first")
      return
    }
    serving = serveShadow(link => attachAuthority(editor, link, ctx))
    ctx.onDispose(() => { serving?.stop(); serving = undefined })
    editor.message(`[shadow] serving — connect with: ${serving.url}`)
  }, "Serve this editor as an authority on a loopback WebSocket and print the one-time URL.")

  ctx.command("shadow-stop-server", ({ editor }) => {
    if (!serving) { editor.message("[shadow] not serving"); return }
    serving.stop()
    serving = undefined
    editor.message("[shadow] server stopped")
  }, "Stop the shadow WebSocket server.")
}
