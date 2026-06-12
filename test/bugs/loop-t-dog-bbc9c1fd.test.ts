import { expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { BufferModel } from "../../src/kernel/buffer"
import { MemCas } from "../../src/shadow/cas"
import { announceBuffer, attachAuthority, attachShadow } from "../../src/shadow/shadow"
import { FakeLink } from "../shadow/fake-link"

// t-dog-bbc9c1fd [bug]: announced buffer point at EOF not 0.
//
// Already fixed by `syncBufferText` (same root cause as t-dog-b7878447 — chunk
// reassembly used replaceRange which forces point to start+replacement.length).
// loop-t-dog-b7878447.test.ts covers the bare announce; this test adds the
// announce-current → switch-to-buffer Cmd path the dogfood repro actually hit:
// A's argv file is current, announceBuffer ships switch-to-buffer after the
// buffer-ref, and S must land on it with point at BOB once chunks reassemble.

function rig() {
  const A = new Editor()
  const S = new Editor()
  const { sLink, aLink } = FakeLink.pair()
  attachAuthority(A, aLink, { cas: new MemCas(), flushMs: 0 })
  attachShadow(S, sLink, { cas: new MemCas() })
  const drain = () => { while (sLink.inflight.length || aLink.inflight.length) { sLink.drainSide(); aLink.drainSide() } }
  return { A, S, drain }
}

test("announce current → switch-to-buffer → CAS miss → chunks: S lands at point 0", () => {
  const { A, S, drain } = rig()
  const text = Array.from({ length: 261 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
  const file = A.addBuffer(new BufferModel({ id: "f1", name: "big.ts", path: "/p/big.ts", text, kind: "file" }))
  A.switchToBuffer(file.id) // A's argv file → announceBuffer ships switch-to-buffer.

  for (const b of A.buffers.values()) announceBuffer(A, b.id)
  drain()

  const bufS = S.buffers.get("f1")!
  expect(bufS.text).toBe(text)
  expect(S.currentBufferId).toBe("f1")
  // The bug: replaceRange in chunk reassembly left point at text.length.
  expect(bufS.point).toBe(0)
  expect(bufS.dirty).toBe(false)
})
