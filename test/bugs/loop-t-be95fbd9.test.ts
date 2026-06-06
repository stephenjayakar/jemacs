import { expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { BufferModel } from "../../src/kernel/buffer"
import { attachAuthority, attachShadow, authorityState } from "../../src/shadow/shadow"
import { MemCas } from "../../src/shadow/cas"
import { FakeLink } from "../shadow/fake-link"

// t-be95fbd9: flushExternal was only ever driven by sim.drain(). Over a real
// link (Stdio/Ws) nothing calls it — an external edit on A lands in
// state.external and sits there forever; S never learns of it. Fix: A arms a
// debounce timer on ext-buffer (and resets it on each S op) so the rebase
// ships once S has been quiet for `flushMs`, with an every-N-acks fallback so
// a continuously-typing S can't defer it indefinitely.

function rig() {
  const A = new Editor()
  const S = new Editor()
  A.addBuffer(new BufferModel({ id: "b", name: "b", text: "" }))
  S.addBuffer(new BufferModel({ id: "b", name: "b", text: "" }))
  const { sLink, aLink } = FakeLink.pair()
  const cas = new MemCas()
  const dA = attachAuthority(A, aLink, { cas })
  const dS = attachShadow(S, sLink, { cas })
  const pump = () => { while (sLink.inflight.length || aLink.inflight.length) { aLink.drainSide(); sLink.drainSide() } }
  return { A, S, sLink, aLink, pump, detach: () => { dS(); dA() } }
}

test("t-be95fbd9: idle S — external edit on A reaches S via debounce timer", async () => {
  const { A, S, pump, detach } = rig()

  A.buffers.get("b")!.replaceRange(0, 0, "EXT")
  expect(authorityState(A)!.external.get("b")?.length).toBe(1)
  pump()
  // Nothing in flight yet — ext is deferred, not sent eagerly.
  expect(S.buffers.get("b")!.text).toBe("")

  // Real link: no sim.drain() to call flushExternal for us. Pre-fix the rebase
  // never ships; post-fix the debounce timer fires.
  await new Promise(r => setTimeout(r, 80))
  pump()

  expect(authorityState(A)!.external.get("b")?.length ?? 0).toBe(0)
  expect(S.buffers.get("b")!.text).toBe("EXT")
  expect(S.buffers.get("b")!.text).toBe(A.buffers.get("b")!.text)
  detach()
})

test("t-be95fbd9: hot S — external edit reaches S via Nth-ack fallback", () => {
  const { A, S, pump, detach } = rig()

  // External first, then S types without ever pausing long enough for the
  // debounce. Pre-fix ext sits behind the stream; post-fix the ack-count
  // fallback forces a flush mid-stream.
  A.buffers.get("b")!.replaceRange(0, 0, "EXT")
  for (let i = 0; i < 40; i++) S.buffers.get("b")!.insert("s")
  pump()

  expect(authorityState(A)!.external.get("b")?.length ?? 0).toBe(0)
  expect(S.buffers.get("b")!.text).toContain("EXT")
  expect(S.buffers.get("b")!.text).toBe(A.buffers.get("b")!.text)
  detach()
})
