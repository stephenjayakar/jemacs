#!/usr/bin/env bun
/**
 * DST soak — `bun run test/shadow/soak.ts`
 *
 * Cranks the test.skip("soak") in sim.prop.test.ts: 200 seeds × 2000 steps,
 * across all five link adversaries, with the full action set (externals on).
 * Prints a per-adversary progress line and a per-failure repro block.
 *
 * Exit 0 ⇔ zero failures.
 */

import { Simulator, type Adversary, type SimulatorOpts } from "./sim"

// Same five as sim-adversary.prop.test.ts.
const ADVERSARIES: Array<[string, Adversary]> = [
  ["reorder", { reorderP: 0.5, dropP: 0,    dupP: 0,   maxDelay: 3 }],
  ["drop",    { reorderP: 0,   dropP: 0.2,  dupP: 0,   maxDelay: 1 }],
  ["dup",     { reorderP: 0,   dropP: 0,    dupP: 0.3, maxDelay: 1 }],
  ["delay",   { reorderP: 0,   dropP: 0,    dupP: 0,   maxDelay: 8 }],
  ["chaos",   { reorderP: 0.3, dropP: 0.1,  dupP: 0.1, maxDelay: 5 }],
]

interface Failure {
  phase: string
  adversary: string
  seed: number
  step: number
  message: string
}

interface Phase {
  name: string
  seeds: number
  steps: number
  opts: (adv: Adversary) => SimulatorOpts
}

function tryRun(seed: number, opts: SimulatorOpts, steps: number): { ok: true } | { ok: false; step: number; message: string } {
  const sim = new Simulator(seed, opts)
  try {
    sim.run(steps)
    sim.checkInvariant()
    return { ok: true }
  } catch (e) {
    // sim.fail() embeds seed/step/buffer/trace-tail in the message; capture stepN
    // separately so the summary table doesn't have to parse it back out.
    return { ok: false, step: sim.stepN, message: (e as Error).message }
  }
}

function runPhase(phase: Phase, failures: Failure[]): void {
  const total = ADVERSARIES.length * phase.seeds
  console.log(`\n── ${phase.name}: ${phase.seeds} seeds × ${phase.steps} steps × ${ADVERSARIES.length} adversaries (${total} runs) ──`)
  const t0 = performance.now()
  let done = 0
  for (const [advName, adv] of ADVERSARIES) {
    let advFail = 0
    const a0 = performance.now()
    for (let seed = 1; seed <= phase.seeds; seed++) {
      const r = tryRun(seed, phase.opts(adv), phase.steps)
      done++
      if (!r.ok) {
        advFail++
        failures.push({ phase: phase.name, adversary: advName, seed, step: r.step, message: r.message })
        console.error(`\n  ✗ [${phase.name}] adversary=${advName} seed=${seed} step=${r.step}`)
        // First line of sim.fail() is the load-bearing summary; rest is repro+trace.
        for (const line of r.message.split("\n")) console.error(`    ${line}`)
      }
    }
    const dt = ((performance.now() - a0) / 1000).toFixed(1)
    const status = advFail === 0 ? "ok" : `${advFail} FAIL`
    console.log(`  ${advName.padEnd(8)} ${done}/${total}  ${status.padEnd(8)} ${dt}s`)
  }
  console.log(`  ⇒ ${(((performance.now() - t0) / 1000)).toFixed(1)}s total`)
}

// ── Phases ──────────────────────────────────────────────────────────────────

const SEEDS = Number(process.env.SOAK_SEEDS ?? 200)
const STEPS = Number(process.env.SOAK_STEPS ?? 2000)

const phases: Phase[] = [
  {
    name: "main",
    seeds: SEEDS,
    steps: STEPS,
    opts: adv => ({ adversary: adv, withExternalSplice: true }),
  },
]

const failures: Failure[] = []
const T0 = performance.now()

for (const p of phases) runPhase(p, failures)

// Conditional extensions: only if main is clean (per task), so a real
// convergence bug doesn't get buried under follow-on noise.
if (failures.length === 0) {
  // 2-buffer: second buffer is inert (sim.ts only drives bufferIds[0]) but it
  // still exercises per-buffer state maps (pending/external/lastSeq) for
  // cross-contamination, and checkInvariant asserts buf-2 stays at initialText.
  runPhase({
    name: "2-buffer",
    seeds: SEEDS,
    steps: STEPS,
    opts: adv => ({ adversary: adv, withExternalSplice: true, bufferIds: ["buf-1", "buf-2"] }),
  }, failures)

  // Larger "alphabet": KEYS is module-const in sim.ts so we can't widen the key
  // set from here, but a long mixed initialText pushes splice offsets, undo
  // depth, and transformPast shift arithmetic well past the empty-start case.
  const wide = Array.from({ length: 256 }, (_, i) => String.fromCharCode(33 + (i % 94))).join("")
  runPhase({
    name: "wide-initial",
    seeds: SEEDS,
    steps: STEPS,
    opts: adv => ({ adversary: adv, withExternalSplice: true, initialText: wide }),
  }, failures)
} else {
  console.log("\n(skipping 2-buffer / wide-initial extensions: main phase has failures)")
}

// ── Summary ─────────────────────────────────────────────────────────────────

const wall = ((performance.now() - T0) / 1000).toFixed(1)
if (failures.length === 0) {
  console.log(`\n✓ soak clean — 0 failures in ${wall}s`)
  process.exit(0)
}

console.error(`\n✗ soak: ${failures.length} failure(s) in ${wall}s\n`)
console.error("  phase        adversary  seed   step")
console.error("  ───────────  ─────────  ─────  ─────")
for (const f of failures) {
  console.error(`  ${f.phase.padEnd(11)}  ${f.adversary.padEnd(9)}  ${String(f.seed).padEnd(5)}  ${f.step}`)
}
process.exit(1)
