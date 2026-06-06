import { expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { BufferModel } from "../../src/kernel/buffer"
import { attachAuthority, attachShadow, flushExternal, shadowState } from "../../src/shadow/shadow"
import type { ShadowOp } from "../../src/shadow/ops"
import type { ShadowLink } from "../../src/shadow/link"
import { Simulator } from "../shadow/sim"

// t-f360d582: rebase rewound by *count of pending entries*; an ack reordered
// ahead of the rebase prunes pending first, so S under-rewinds and applies the
// authority's ops on the wrong base. Fix: S records buf.seq alongside wire-seq
// at send time and rebase maps wire baseSeq → buf.seq → buf.rewindTo(bufSeq).

type Recv = (op: ShadowOp) => void
function manualPair() {
  const toA: ShadowOp[] = [], toS: ShadowOp[] = []
  let sRecv: Recv = () => {}, aRecv: Recv = () => {}
  const sLink: ShadowLink = { peerId: "A", role: "shadow", trust: "full", send: o => toA.push(o), on: h => { sRecv = h }, close: () => {} }
  const aLink: ShadowLink = { peerId: "S", role: "authority", trust: "full", send: o => toS.push(o), on: h => { aRecv = h }, close: () => {} }
  return { toA, toS, deliverA: (o: ShadowOp) => aRecv(o), deliverS: (o: ShadowOp) => sRecv(o), sLink, aLink }
}

test("ack reordered before conflict-rebase: S rewinds by buf.seq, not pending count", () => {
  const { toA, toS, deliverA, deliverS, sLink, aLink } = manualPair()
  const S = new Editor(), A = new Editor()
  const bufS = S.addBuffer(new BufferModel({ id: "b", name: "b", text: "hello" }))
  const bufA = A.addBuffer(new BufferModel({ id: "b", name: "b", text: "hello" }))
  attachAuthority(A, aLink)
  attachShadow(S, sLink)

  bufS.splice(0, 1, "")          // S: "ello", wire-seq 1
  bufA.splice(0, 2, "XX")        // A ext overlapping S's edit: "XXllo"
  deliverA(toA.shift()!)         // overlap → A ships rebase{baseSeq:0} + ack{1}
  expect(bufA.text).toBe("XXllo")

  const rebase = toS.find(o => o.kind === "rebase")!
  const ack = toS.find(o => o.kind === "ack")!

  // A→S link reorders: ack first, rebase second.
  deliverS(ack)
  expect(shadowState(S)!.pending.get("b")?.length ?? 0).toBe(0)
  deliverS(rebase)
  // pre-fix: 0 pending ⇒ 0 undos ⇒ ext applied on "ello" → "XXlo"
  expect(bufS.text).toBe(bufA.text)
})

test("ack reordered before flushExternal-rebase at older baseSeq", () => {
  const { toA, toS, deliverA, deliverS, sLink, aLink } = manualPair()
  const S = new Editor(), A = new Editor()
  const bufS = S.addBuffer(new BufferModel({ id: "b", name: "b", text: "" }))
  const bufA = A.addBuffer(new BufferModel({ id: "b", name: "b", text: "" }))
  attachAuthority(A, aLink)
  attachShadow(S, sLink)

  bufA.splice(0, 0, "X")         // ext on A
  bufS.insert("a")               // wire-seq 1
  bufS.insert("b")               // wire-seq 2; S="ab"

  deliverA(toA.shift()!)         // A applies seq1 past ext → "aX", lastSeq=1, ack{1}
  flushExternal(A)               // rebase{baseSeq:1, ops:[X@1]}
  deliverA(toA.shift()!)         // A applies seq2 (ext flushed) → "abX", ack{2}
  expect(bufA.text).toBe("abX")

  const ack2 = toS.find(o => o.kind === "ack" && o.upTo === 2)!
  const rebase = toS.find(o => o.kind === "rebase")!

  deliverS(ack2)                 // pending → []
  deliverS(rebase)               // pre-fix: 0 undos ⇒ X@1 on "ab" → "aXb"
  expect(bufS.text).toBe(bufA.text)
})

// Property guard: interleaveExt + reorder adversary reaches the ack-before-rebase
// ordering the hand-driven cases above pin down (sim-adversary.prop.test.ts only
// runs the bracketed-ext path, which never sends rebase at baseSeq < max-sent).
test("sim: interleaveExt × reorder adversary converges", () => {
  const adversary = { reorderP: 0.5, dropP: 0, dupP: 0, maxDelay: 3 }
  for (const seed of [1, 7, 42, 1337, 90210]) {
    const sim = new Simulator(seed, { withExternalSplice: true, interleaveExt: true, adversary })
    sim.run(300)
    sim.checkInvariant()
  }
})
