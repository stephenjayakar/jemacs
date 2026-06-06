import { describe, expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { BufferModel } from "../../src/kernel/buffer"
import { attachShadow, authorityState, shadowState, type ShadowLink, type ShadowOp } from "../../src/shadow/shadow"
import { getCustomFace } from "../../src/runtime/faces"
import {
  install,
  shadowModeLighter,
  shadowPendingSpans,
  SHADOW_PENDING_FACE,
  SHADOW_PENDING_LOCAL,
} from "../../plugins/shadow"

/** Shadow-side link that queues outbound ops and lets the test feed inbound ones. */
function queuedLink() {
  const sent: ShadowOp[] = []
  let recv: (op: ShadowOp) => void = () => {}
  const link: ShadowLink & { partitioned: boolean } = {
    peerId: "A", role: "shadow", trust: "full", partitioned: false,
    send: op => sent.push(op),
    on: h => { recv = h },
    close: () => {},
  }
  return { link, sent, deliver: (op: ShadowOp) => recv(op) }
}

describe("shadow plugin", () => {
  test("defface registers shadow-pending as dim/italic", () => {
    install(new Editor())
    const face = getCustomFace("shadow-pending")
    expect(face).toBeDefined()
    expect(face!.spec.italic).toBe(true)
    expect(face!.spec.fg).toBeDefined()
  })

  test("overlay spans cover pending ops; ack shrinks them", () => {
    const editor = new Editor()
    install(editor)
    const buf = editor.addBuffer(new BufferModel({ id: "buf-1", name: "t", text: "" }))
    const { link, sent, deliver } = queuedLink()
    attachShadow(editor, link)

    // Two optimistic edits → two pending splices.
    buf.insert("hello")
    buf.insert(" world")
    expect(buf.text).toBe("hello world")
    const pending = buf.locals.get(SHADOW_PENDING_LOCAL) as unknown[]
    expect(pending.length).toBe(2)

    // Spans cover both inserts in *current* coordinates: "hello"=[0,5), " world"=[5,11).
    let spans = shadowPendingSpans(buf)
    expect(spans).toEqual([
      { start: 0, end: 5, face: SHADOW_PENDING_FACE },
      { start: 5, end: 11, face: SHADOW_PENDING_FACE },
    ])
    // Overlay source is wired into fontLock.
    expect(editor.fontLock(buf).filter(s => s.face === SHADOW_PENDING_FACE)).toEqual(spans)

    // Ack the first op → only " world" remains pending.
    expect(sent[0]!.kind).toBe("splice")
    deliver({ kind: "ack", upTo: (sent[0] as { seq: number }).seq })
    expect(shadowState(editor)!.pending.get("buf-1")!.length).toBe(1)

    spans = shadowPendingSpans(buf)
    expect(spans).toEqual([{ start: 5, end: 11, face: SHADOW_PENDING_FACE }])

    // Ack the rest → no spans.
    deliver({ kind: "ack", upTo: (sent[1] as { seq: number }).seq })
    expect(shadowPendingSpans(buf)).toEqual([])
  })

  test("earlier span shifts past a later non-adjacent insert", () => {
    const editor = new Editor()
    install(editor)
    const buf = editor.addBuffer(new BufferModel({ id: "buf-2", name: "t", text: "abcdef" }))
    const { link } = queuedLink()
    attachShadow(editor, link)

    buf.point = 6
    buf.insert("XY")          // pending[0] at [6,8) — current coords [8,10) after next op
    buf.point = 0
    buf.insert("__")          // pending[1] at [0,2)
    expect(buf.text).toBe("__abcdefXY")

    expect(shadowPendingSpans(buf)).toEqual([
      { start: 8, end: 10, face: SHADOW_PENDING_FACE },
      { start: 0, end: 2, face: SHADOW_PENDING_FACE },
    ])
  })

  test("modeline lighter reflects pending count and link state", () => {
    const editor = new Editor()
    install(editor)
    const buf = editor.addBuffer(new BufferModel({ id: "buf-3", name: "t", text: "" }))

    // No link → no segment.
    expect(shadowModeLighter(buf)).toBe("")

    const { link, deliver } = queuedLink()
    attachShadow(editor, link)
    expect(shadowModeLighter(buf)).toBe(" [✓]")

    buf.insert("a")
    buf.insert("b")
    expect(shadowModeLighter(buf)).toBe(" [⇅ 2]")

    deliver({ kind: "ack", upTo: 1 })
    expect(shadowModeLighter(buf)).toBe(" [⇅ 1]")

    deliver({ kind: "ack", upTo: 2 })
    expect(shadowModeLighter(buf)).toBe(" [✓]")

    link.partitioned = true
    expect(shadowModeLighter(buf)).toBe(" [⊘ partition]")
  })
})

// ── Command-level: shadow-serve / shadow-connect over a real loopback socket ──

async function until(pred: () => boolean, ms = 5_000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("until: timed out")
    await new Promise(r => setTimeout(r, 5))
  }
}

function captureMessages(editor: Editor): string[] {
  const msgs: string[] = []
  editor.events.on("message", ({ text }) => { msgs.push(text) })
  return msgs
}

describe("shadow plugin commands", () => {
  test("M-x shadow-serve on A + M-x shadow-connect ws:// on S → converge", async () => {
    const A = new Editor()
    const S = new Editor()
    install(A)
    install(S)
    const aMsgs = captureMessages(A)
    const sMsgs = captureMessages(S)
    // Same id on both sides so the splice routes; real flow uses announceBuffer.
    const bufA = A.addBuffer(new BufferModel({ id: "buf-ws", name: "t", text: "" }))
    const bufS = S.addBuffer(new BufferModel({ id: "buf-ws", name: "t", text: "" }))

    await A.run("shadow-serve")
    const serveMsg = aMsgs.find(m => m.includes("ws://127.0.0.1:"))
    expect(serveMsg).toBeDefined()
    const url = serveMsg!.match(/ws:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)![0]

    try {
      await S.run("shadow-connect", [url])
      expect(sMsgs.some(m => m.includes("connected to"))).toBe(true)
      expect(shadowState(S)?.link.role).toBe("shadow")
      await until(() => authorityState(A) !== undefined)
      expect(authorityState(A)!.link.role).toBe("authority")
      expect(authorityState(A)!.link.trust).toBe("full")

      bufS.insert("via M-x")
      await until(() => bufA.text === "via M-x")
      await until(() => (shadowState(S)!.pending.get("buf-ws") ?? []).length === 0)
      expect(bufS.text).toBe(bufA.text)

      // Second serve/connect while active is refused with a hint, not a crash.
      await A.run("shadow-serve")
      expect(aMsgs.some(m => m.includes("already serving"))).toBe(true)
      await S.run("shadow-connect", [url])
      expect(sMsgs.some(m => m.includes("already connected"))).toBe(true)

      await S.run("shadow-disconnect")
      await until(() => sMsgs.some(m => m.includes("disconnected")))
    } finally {
      await A.run("shadow-stop-server")
    }
    expect(aMsgs.some(m => m.includes("server stopped"))).toBe(true)
  })
})
