import { Editor } from "../../src/kernel/editor"
import { BufferModel } from "../../src/kernel/buffer"
import { attachAuthority, attachShadow, authorityState, flushExternal, resendPending, shadowState } from "../../src/shadow/shadow"
import { MemCas } from "../../src/shadow/cas"
import { FakeLink, type Adversary } from "./fake-link"

export { FakeLink } from "./fake-link"
export type { Adversary } from "./fake-link"

// ── SeededRng ───────────────────────────────────────────────────────────────
// LCG (Numerical Recipes constants) — same generator as test/property/buffer.prop.test.ts,
// wrapped so the simulator can hand out ints/picks without threading a closure.

export class SeededRng {
  private s: number
  constructor(seed: number) { this.s = seed >>> 0 }
  next(): number { return (this.s = (this.s * 1664525 + 1013904223) >>> 0) / 0x100000000 }
  /** Uniform int in [0, n). n=0 ⇒ 0. */
  int(n: number): number { return n > 0 ? Math.floor(this.next() * n) : 0 }
  pick<T>(xs: readonly T[]): T { return xs[this.int(xs.length)]! }
}

// ── Simulator ───────────────────────────────────────────────────────────────

/** Small alphabet + nav keys. Dispatched via `applyKey` (direct BufferModel calls)
 *  rather than `Editor.handleKey` so the sim stays kernel-only — no config/lisp
 *  install ⇒ deterministic, fast, no FS, no `crypto.randomUUID` beyond the two
 *  default Editor buffers (which the invariant skips). */
const KEYS = ["a", "b", "c", "d", "e", "\n", "<left>", "<right>", "<bs>", "<del>", "<home>", "<end>"] as const
export type Key = typeof KEYS[number]

const EXT_CHARS = "VWXYZ"

export type Action =
  | { k: "key"; key: Key }
  | { k: "ext"; from: number; to: number; text: string }
  | { k: "partition" }
  | { k: "heal" }
  | { k: "tick"; n: number }

function applyKey(buf: BufferModel, key: Key): void {
  switch (key) {
    case "<left>":  buf.move(-1); break
    case "<right>": buf.move(1); break
    case "<bs>":    buf.deleteBackward(); break
    case "<del>":   buf.deleteForward(); break
    case "<home>":  buf.point = 0; break
    case "<end>":   buf.point = buf.text.length; break
    default:        buf.insert(key)
  }
}

export type SimulatorOpts = {
  initialText?: string
  bufferIds?: string[]
  /** Include externalSplice(A) in the random action mix. */
  withExternalSplice?: boolean
  /** Allow ext to be a non-empty replace and to interleave with in-flight S ops
   *  (no drain bracketing). The baseline oracle is unsound in this mode — only
   *  A≡S is checked. Exists to unmask the overlap-conflict path in applyAuthorityOp. */
  interleaveExt?: boolean
  /** Link adversary. Threaded to both directions of the FakeLink pair. */
  adversary?: Partial<Adversary>
}

export class Simulator {
  readonly A: Editor
  readonly S: Editor
  readonly baseline: Editor
  readonly sLink: FakeLink
  readonly aLink: FakeLink
  readonly rng: SeededRng
  readonly bufferIds: readonly string[]
  readonly trace: Action[] = []
  readonly withExternalSplice: boolean
  readonly interleaveExt: boolean
  stepN = 0

  constructor(readonly seed: number, opts: SimulatorOpts = {}) {
    this.rng = new SeededRng(seed)
    this.withExternalSplice = opts.withExternalSplice ?? false
    this.interleaveExt = opts.interleaveExt ?? false
    this.A = new Editor()
    this.S = new Editor()
    this.baseline = new Editor()
    this.bufferIds = opts.bufferIds ?? ["buf-1"]
    const text = opts.initialText ?? ""
    for (const id of this.bufferIds) {
      this.A.addBuffer(new BufferModel({ id, name: id, text }))
      this.S.addBuffer(new BufferModel({ id, name: id, text }))
      this.baseline.addBuffer(new BufferModel({ id, name: id, text }))
    }
    // Separate link rng so adversary draws don't perturb genAction's stream.
    const linkRng = new SeededRng((seed ^ 0x9e3779b9) >>> 0)
    const { sLink, aLink } = FakeLink.pair({ rng: linkRng, adversary: opts.adversary })
    this.sLink = sLink
    this.aLink = aLink
    const cas = new MemCas()
    attachAuthority(this.A, aLink, { cas })
    attachShadow(this.S, sLink, { cas })
  }

  buf(e: Editor, id = this.bufferIds[0]!): BufferModel { return e.buffers.get(id)! }

  /** Nothing in flight, no unacked pending on S, no unflushed external on A, nothing held. */
  private quiescent(): boolean {
    if (this.sLink.partitioned || this.sLink.inflight.length || this.aLink.inflight.length) return false
    const ss = shadowState(this.S)
    const as = authorityState(this.A)
    if (as && as.held.size > 0) return false
    for (const id of this.bufferIds) {
      if ((ss?.pending.get(id)?.length ?? 0) > 0) return false
      if ((as?.external.get(id)?.length ?? 0) > 0) return false
    }
    return true
  }

  /** Heal, then alternate {pump, retransmit, flush} until quiescent. pump uses
   *  the link's no-adversary drain, so anything that was dropped during tick()
   *  is recovered by S resending pending and A re-acking. */
  drain(): void {
    this.sLink.partitioned = false
    this.aLink.partitioned = false
    const pump = () => {
      while (this.aLink.inflight.length || this.sLink.inflight.length) {
        this.aLink.drainSide()
        this.sLink.drainSide()
      }
    }
    pump()
    for (let i = 0; !this.quiescent(); i++) {
      if (i > 64) throw this.fail(this.bufferIds[0]!, `drain did not converge after ${i} rounds`)
      resendPending(this.S)
      pump()
      flushExternal(this.A)
      pump()
    }
  }

  step(): Action {
    this.stepN++
    const a = this.genAction()
    this.trace.push(a)
    this.apply(a)
    // ext is bracketed by drains: one before (in genAction, so coords agree on
    // A and baseline) and one after (here, so S has the ext before the next key).
    // Without the trailing drain, absolute-position keys like <end> reference
    // different text lengths on S vs baseline and the oracle is unsound.
    // interleaveExt drops the bracketing (and the baseline oracle) so ext can
    // race S's in-flight ops and reach the overlap-conflict path on A.
    if (a.k === "ext" && !this.interleaveExt) this.drain()
    return a
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) this.step()
    this.drain()
  }

  private genAction(): Action {
    const r = this.rng
    const roll = r.int(20)
    if (roll < 10) return { k: "key", key: r.pick(KEYS) }
    if (roll < 15) return { k: "tick", n: r.int(5) }
    if (roll < 18 || !this.withExternalSplice) {
      return this.sLink.partitioned ? { k: "heal" } : { k: "partition" }
    }
    // externalSplice — only at a quiescent point so (from,to) means the same
    // thing on A and baseline. Pure insert: a non-empty replaced range can put
    // S.point inside it, where the transform invalidates S's next op while
    // baseline's gravity-clamped point applies it — A≢baseline by construction.
    // interleaveExt keeps this leading drain (so ext is at most one entry deep
    // when S ops arrive — multi-ext frame composition is a separate workstream)
    // but allows a non-empty replace range and skips the trailing drain.
    if (!this.quiescent()) this.drain()
    const len = this.buf(this.A).text.length
    const from = r.int(len + 1)
    const to = this.interleaveExt ? from + r.int(len + 1 - from) : from
    const text = Array.from({ length: 1 + r.int(2) }, () => EXT_CHARS[r.int(EXT_CHARS.length)]).join("")
    return { k: "ext", from, to, text }
  }

  apply(a: Action): void {
    switch (a.k) {
      case "key":
        applyKey(this.buf(this.S), a.key)
        applyKey(this.buf(this.baseline), a.key)
        break
      case "ext":
        // `splice`, not `replaceRange`: we want gravity point-adjust on baseline so
        // it tracks S's post-rebase point, not a forced jump to end-of-insert.
        this.buf(this.A).splice(a.from, a.to, a.text)
        if (!this.interleaveExt) this.buf(this.baseline).splice(a.from, a.to, a.text)
        break
      case "partition":
        this.sLink.partitioned = true
        this.aLink.partitioned = true
        break
      case "heal":
        this.sLink.partitioned = false
        this.aLink.partitioned = false
        break
      case "tick":
        this.aLink.tick(a.n)
        this.sLink.tick(a.n)
        break
    }
  }

  /** A.text ≡ S.text ≡ baseline.text per buffer; S.point ≡ baseline.point.
   *  A.point is *not* checked: attachShadow doesn't emit Point ops yet, so A's
   *  cursor lags S by design — separate workstream, not a convergence failure. */
  checkInvariant(): void {
    for (const id of this.bufferIds) {
      const a = this.buf(this.A, id)
      const s = this.buf(this.S, id)
      const b = this.buf(this.baseline, id)
      if (a.text !== s.text) {
        throw this.fail(id, `A≢S\n  A=${JSON.stringify(a.text)}\n  S=${JSON.stringify(s.text)}`)
      }
      // baseline oracle is unsound under interleaveExt (see step()).
      if (!this.interleaveExt) {
        if (s.text !== b.text) {
          throw this.fail(id, `text diverged\n  A=${JSON.stringify(a.text)}\n  S=${JSON.stringify(s.text)}\n  B=${JSON.stringify(b.text)}`)
        }
        if (s.point !== b.point) {
          throw this.fail(id, `point diverged S=${s.point} baseline=${b.point} (text=${JSON.stringify(s.text)})`)
        }
      }
    }
    const ss = shadowState(this.S)
    for (const id of this.bufferIds) {
      const pend = ss?.pending.get(id) ?? []
      if (pend.length) throw this.fail(id, `pending not drained: ${pend.length} ops`)
    }
  }

  private fail(bufferId: string, msg: string): Error {
    const start = Math.max(0, this.trace.length - 30)
    const tail = this.trace.slice(start).map((a, i) => `  [${start + i}] ${JSON.stringify(a)}`).join("\n")
    const optBits = [
      this.withExternalSplice && "withExternalSplice:true",
      this.interleaveExt && "interleaveExt:true",
    ].filter(Boolean).join(", ")
    return new Error(
      `seed=${this.seed} step=${this.stepN} buffer=${bufferId}: ${msg}\n` +
      `repro: new Simulator(${this.seed}${optBits ? `, {${optBits}}` : ""}).run(${this.stepN})\n` +
      `last ${this.trace.length - start} actions:\n${tail}`,
    )
  }
}
