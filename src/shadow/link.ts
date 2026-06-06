import type { Editor } from "../kernel/editor"
import { BufferModel } from "../kernel/buffer"
import type { ShadowOp } from "./ops"

/** Which side of the A↔S pair this link instance lives on. Determines which op
 *  kinds `applyRemoteOp` will honor — Cmd is only ever processed by the authority. */
export type ShadowRole = "authority" | "shadow"

export interface ShadowLink {
  readonly peerId: string
  readonly role: ShadowRole
  /** Server-assigned per-auth; never read from the wire. */
  readonly trust: "full" | "propose"
  send(op: ShadowOp): void
  on(handler: (op: ShadowOp) => void): void
  close(): void
}

/**
 * Single entry point for ops arriving over a link. Everything inbound funnels
 * here so the direction/trust gates (DESIGN.md §Ops) live in one place.
 *
 * Returns false when the op was rejected (wrong direction, untrusted Cmd,
 * unknown buffer) so the caller can surface it; true otherwise.
 */
export function applyRemoteOp(editor: Editor, link: ShadowLink, op: ShadowOp): boolean {
  switch (op.kind) {
    case "splice": {
      const buf = editor.buffers.get(op.bufferId)
      if (!buf) return false
      // Suppress the outbound emit so a remote splice doesn't echo back.
      const emit = buf.onSplice
      buf.onSplice = undefined
      try {
        buf.replaceRange(op.from, op.to, op.text)
      } finally {
        buf.onSplice = emit
      }
      return true
    }
    case "point": {
      const buf = editor.buffers.get(op.bufferId)
      if (!buf) return false
      buf.point = op.point
      return true
    }
    case "buffer": {
      const buf = new BufferModel({ id: op.id, name: op.path ?? op.id, path: op.path, text: op.text, mode: op.mode })
      buf.link = link
      editor.addBuffer(buf)
      return true
    }
    case "layout":
      // Window-tree restoration needs an Editor primitive that doesn't exist yet;
      // accepted but unapplied until that lands.
      return true
    case "command": {
      // trust:"full" means the peer is the same user over an SSH-auth'd channel —
      // executing arbitrary commands is the *purpose* (M-x compile runs on A).
      // The security boundary is the link's auth handshake, not an allowlist here.
      // See DESIGN.md § Transport. trust is set server-side per auth, never from the wire.
      if (link.role !== "authority" || link.trust !== "full") {
        editor.message(`[shadow] rejected command '${String(op.name).slice(0, 40)}' on ${link.role}/${link.trust} link`)
        return false
      }
      if (typeof op.name !== "string" || !Array.isArray(op.args)) return false
      editor.run(op.name, op.args.map(a => typeof a === "string" ? a : String(a)))
        .catch((e: unknown) => editor.message(`[shadow] command '${op.name}' failed: ${(e as Error)?.message ?? e}`))
      return true
    }
    case "ack":
    case "rebase":
    case "lsp":
    case "buffer-ref":
    case "have":
    case "want":
    case "chunk":
      // Reconciliation / CAS-sync / plugin-stub ops — consumed by the shadow layer, not the kernel.
      return true
  }
}
