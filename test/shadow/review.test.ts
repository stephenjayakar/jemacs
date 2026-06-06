/**
 * Regression coverage for the PR #20 review findings — each describe block is
 * one CONFIRMED divergence/corruption bug that the original sim was masking.
 * Every test here failed on the pre-fix tree and passes post-fix.
 */
import { describe, expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { BufferModel } from "../../src/kernel/buffer"
import { announceBuffer, attachAuthority, attachShadow, authorityState, flushExternal, shadowState } from "../../src/shadow/shadow"
import { applyRemoteOp } from "../../src/shadow/link"
import { MemCas, chunkText } from "../../src/shadow/cas"
import type { Chunk, ShadowOp } from "../../src/shadow/ops"
import { FakeLink } from "./fake-link"
import { Simulator } from "./sim"

/** A↔S over FakeLink. Adds one buffer "b" on each side *before* attach so
 *  hookBuffer wires it (attachShadow doesn't hook later local addBuffer). */
function rig(text = "") {
  const A = new Editor()
  const S = new Editor()
  const bufA = A.addBuffer(new BufferModel({ id: "b", name: "b", text }))
  const bufS = S.addBuffer(new BufferModel({ id: "b", name: "b", text }))
  const { sLink, aLink } = FakeLink.pair()
  attachAuthority(A, aLink, { cas: new MemCas() })
  attachShadow(S, sLink, { cas: new MemCas() })
  const drain = () => { while (sLink.inflight.length || aLink.inflight.length) { aLink.drainSide(); sLink.drainSide() } }
  return { A, S, bufA, bufS, sLink, aLink, drain }
}

// ── #1 ─ advancePast silently dropped overlapping ext ───────────────────────

describe("review-1: ext overlapping S's splice must rebase, not vanish", () => {
  test("trace: A ext-replace [0,5)→world; S replace [0,3)→HEY; converge to A's text", () => {
    const { A, S, bufA, bufS, drain } = rig("hello")
    // A's external replace lands first (LSP / auto-revert).
    bufA.splice(0, 5, "world")
    expect(authorityState(A)!.external.get("b")!.length).toBe(1)
    // S optimistically replaces an overlapping range.
    bufS.replaceRange(0, 3, "HEY")
    expect(bufS.text).toBe("HEYlo")
    drain()
    flushExternal(A)
    drain()
    // Pre-fix: A="world", S="HEYlo", quiescent, permanently diverged.
    expect(bufA.text).toBe("world")
    expect(bufS.text).toBe("world")
    expect(shadowState(S)!.pending.get("b")?.length ?? 0).toBe(0)
  })

  test("sim interleaveExt: replace-ext racing S ops converges A≡S", () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      const sim = new Simulator(seed, { withExternalSplice: true, interleaveExt: true, initialText: "abcde" })
      sim.run(300)
      sim.checkInvariant()
    }
  })
})

// ── #2 ─ chunk reassembly ignored offset ────────────────────────────────────

describe("review-2: chunk reassembly is offset-addressed, not arrival-ordered", () => {
  function reassemble(chunks: Chunk[]): string {
    const S = new Editor()
    S.addBuffer(new BufferModel({ id: "big", name: "big", text: "" }))
    let recv!: (op: ShadowOp) => void
    const sLink = { peerId: "A", role: "shadow" as const, trust: "full" as const, send: () => {}, on: (h: typeof recv) => { recv = h }, close: () => {} }
    attachShadow(S, sLink, { cas: new MemCas() })
    for (const c of chunks) recv(c)
    return S.buffers.get("big")!.text
  }

  test("reordered chunks assemble correctly", () => {
    const text = "AAAA" + "BBBB" + "CC"
    const cs = chunkText("big", text, 4)
    expect(cs.length).toBe(3)
    // Deliver [1], [0], [2](eof) — pre-fix concatenated to BBBBAAAA CC.
    expect(reassemble([cs[1]!, cs[0]!, cs[2]!])).toBe(text)
  })

  test("eof reordered first waits for fills", () => {
    const text = "AAAA" + "BBBB" + "CC"
    const cs = chunkText("big", text, 4)
    expect(reassemble([cs[2]!, cs[0]!, cs[1]!])).toBe(text)
  })

  test("dup eof after assembly does not truncate", () => {
    const text = "AAAA" + "BBBB" + "CC"
    const cs = chunkText("big", text, 4)
    // Pre-fix: second eof reassembled to just "CC" and overwrote the buffer.
    expect(reassemble([cs[0]!, cs[1]!, cs[2]!, cs[2]!])).toBe(text)
  })

  test("announceBuffer with chunks delivered in reverse order assembles correctly", () => {
    const { A, S, sLink, aLink, drain } = rig()
    const text = Array.from({ length: 5 }, (_, i) => `chunk${i}`.repeat(4000)).join("")
    A.addBuffer(new BufferModel({ id: "big", name: "big", text }))
    announceBuffer(A, "big")
    // S's buffer-ref handler creates "big" and sends Want; A replies with chunks.
    sLink.drainSide() // S processes buffer-ref, sends want
    aLink.drainSide() // A processes want, sends chunks
    expect(sLink.inflight.length).toBeGreaterThan(1)
    sLink.inflight.reverse()
    drain()
    expect(S.buffers.get("big")!.text).toBe(text)
  })
})

// ── #3 ─ attachAuthority didn't hook later buffers ──────────────────────────

describe("review-3: buffers added on A after attach get the external-splice hook", () => {
  test("addBuffer post-attach → splice is recorded in state.external", () => {
    const { A, S, drain } = rig()
    const late = A.addBuffer(new BufferModel({ id: "late", name: "late", text: "x" }))
    S.addBuffer(new BufferModel({ id: "late", name: "late", text: "x" }))
    late.splice(0, 1, "y")
    // Pre-fix: onSplice undefined → external never populated.
    expect(authorityState(A)!.external.get("late")?.length).toBe(1)
    flushExternal(A)
    drain()
    expect(S.buffers.get("late")!.text).toBe("y")
  })

  test("detach restores onAddBuffer", () => {
    const A = new Editor()
    const { aLink } = FakeLink.pair()
    const detach = attachAuthority(A, aLink, { cas: new MemCas() })
    detach()
    expect(A.onAddBuffer).toBeUndefined()
    A.addBuffer(new BufferModel({ id: "after", name: "after", text: "" })).splice(0, 0, "z")
    expect(authorityState(A)).toBeUndefined()
  })
})

// ── #4/#8 ─ authority ops applied with snapshot:true ────────────────────────

describe("review-4: rebase authority ops are not user-undoable", () => {
  test("undo after a rebase does not revert A's external edit", () => {
    const { A, bufA, bufS, drain } = rig("foo")
    const seqBefore = bufS.seq
    bufA.splice(0, 3, "bar")
    flushExternal(A)
    drain()
    expect(bufS.text).toBe("bar")
    // Pre-fix: the rebase recorded an undo node; undo() reverted A's edit.
    expect(bufS.seq).toBe(seqBefore)
    bufS.undo()
    expect(bufS.text).toBe("bar")
  })
})

// ── #5 ─ void editor.run swallowed rejections ───────────────────────────────

describe("review-5: remote command failures are caught and surfaced", () => {
  test("throwing command does not become an unhandled rejection", async () => {
    const A = new Editor()
    const { aLink } = FakeLink.pair()
    A.command("boom", () => { throw new Error("EACCES") })
    let unhandled: unknown
    const trap = (e: unknown) => { unhandled = e }
    process.on("unhandledRejection", trap)
    try {
      applyRemoteOp(A, aLink, { kind: "command", name: "boom", args: [], seq: 1 })
      await new Promise(r => setTimeout(r, 0))
      const messages = [...A.buffers.values()].find(b => b.kind === "messages")!
      expect(messages.text).toContain("[shadow] command 'boom' failed: EACCES")
      expect(unhandled).toBeUndefined()
    } finally {
      process.off("unhandledRejection", trap)
    }
  })
})

// ── #6 ─ onSplice fired on undo/redo/append ─────────────────────────────────

describe("review-6: snapshot:false splices don't enter S's pending", () => {
  test("undo on S does not push a pending op", () => {
    const { S, bufS, aLink } = rig()
    bufS.insert("a"); bufS.insert("b"); bufS.insert("c")
    expect(shadowState(S)!.pending.get("b")!.length).toBe(3)
    expect(aLink.inflight.length).toBe(3)
    bufS.undo()
    // Pre-fix: undo's _splice fired onSplice → pending grew to 4 while undo depth shrank.
    expect(shadowState(S)!.pending.get("b")!.length).toBe(3)
    expect(aLink.inflight.length).toBe(3)
  })

  test("append on S does not ship over the link", () => {
    const { S, bufS, aLink } = rig()
    bufS.append("log line\n")
    expect(shadowState(S)!.pending.get("b")?.length ?? 0).toBe(0)
    expect(aLink.inflight.length).toBe(0)
  })

  test("authority side still records snapshot:false externals (compilation streaming)", () => {
    const { A, bufA } = rig()
    bufA.append("compiler output\n")
    expect(authorityState(A)!.external.get("b")?.length).toBe(1)
  })
})

// ── #7 ─ amalgamateUndo broke pending↔undo-node 1:1 ─────────────────────────

describe("review-7: amalgamateUndo is a no-op while a link is attached", () => {
  test("electric-pair-style insert+insert+amalgamate keeps two undo nodes", () => {
    const { S, bufS } = rig()
    bufS.insert("(")
    bufS.insert(")")
    bufS.amalgamateUndo()
    expect(shadowState(S)!.pending.get("b")!.length).toBe(2)
    // Pre-fix: amalgamate folded the "(" node into ")", so one undo() reverted both
    // and the second undo() walked past the sync point. Post-fix: two distinct nodes.
    bufS.undo()
    expect(bufS.text).toBe("(")
    bufS.undo()
    expect(bufS.text).toBe("")
  })

  test("amalgamateUndo still folds when no link is attached", () => {
    const buf = new BufferModel({ id: "b", name: "b", text: "" })
    buf.insert("(")
    buf.insert(")")
    buf.amalgamateUndo()
    buf.undo()
    expect(buf.text).toBe("")
  })
})
