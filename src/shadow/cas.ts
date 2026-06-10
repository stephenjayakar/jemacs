import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Chunk, Splice } from "./ops"

/** Hex sha256 of `text`. The CAS key. */
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

const SHA256_HEX = /^[0-9a-f]{64}$/

/** `~/.jemacs/cas/<sha>` — where the FileCas stores `text` whose sha256 is `sha`.
 *  `sha` arrives over the wire (BufferRef/Have ops); reject anything that isn't
 *  a 64-hex digest so it can't path-traverse out of cas/. */
export function casPath(sha: string): string {
  if (!SHA256_HEX.test(sha)) throw new Error(`cas: invalid sha '${String(sha).slice(0, 80)}'`)
  return join(homedir(), ".jemacs", "cas", sha)
}

/**
 * Content-addressed store keyed by sha256(text). `lookup` returns the exact text
 * that hashes to `sha`, or undefined if absent. `write` stores `text` and returns
 * its sha. Both sides of a shadow link have their own Cas; they need not share.
 *
 * `lookupAsync` is for backends with no sync read path (IndexedDB). Callers
 * branch on its presence — `cas.lookupAsync ? await cas.lookupAsync(sha) :
 * cas.lookup(sha)` — so a sync Cas takes no microtask yield (the DST drain
 * relies on that). A Cas that only implements `lookupAsync` should return
 * `undefined` from `lookup` (sync miss → falls through to Want).
 */
export interface Cas {
  lookup(sha: string): string | undefined
  lookupAsync?(sha: string): Promise<string | undefined>
  write(text: string): string
}

/** A Cas that can enumerate and drop entries — what `evictCas` needs. */
export interface EvictableCas {
  entries(): Iterable<{ sha: string; size: number; atime: number }>
  delete(sha: string): void
}

/** In-memory Cas for DST and tests. Tracks a logical atime per entry so
 *  `evictCas` behaves the same here as on disk. */
export class MemCas implements Cas, EvictableCas {
  private store = new Map<string, { text: string; atime: number }>()
  private clock = 0
  lookup(sha: string): string | undefined {
    const e = this.store.get(sha)
    if (!e) return undefined
    e.atime = ++this.clock
    return e.text
  }
  write(text: string): string {
    const sha = sha256(text)
    this.store.set(sha, { text, atime: ++this.clock })
    return sha
  }
  *entries(): IterableIterator<{ sha: string; size: number; atime: number }> {
    for (const [sha, e] of this.store) yield { sha, size: e.text.length, atime: e.atime }
  }
  delete(sha: string): void { this.store.delete(sha) }
}

/** Disk-backed Cas at `~/.jemacs/cas/`. Sync IO — entries are small and the
 *  attach path is already sync. */
export class FileCas implements Cas, EvictableCas {
  /** Approximate running total; lazily seeded from a dir scan on first write
   *  so the common path (no cap) pays nothing. */
  private bytes?: number
  constructor(private readonly maxBytes?: number) {}
  lookup(sha: string): string | undefined {
    const p = casPath(sha)
    return existsSync(p) ? readFileSync(p, "utf8") : undefined
  }
  write(text: string): string {
    const sha = sha256(text)
    const p = casPath(sha)
    if (!existsSync(p)) {
      if (this.maxBytes !== undefined) this.bytes ??= scanCasBytes()
      mkdirSync(casDir(), { recursive: true })
      writeFileSync(p, text)
      if (this.maxBytes !== undefined) {
        this.bytes! += text.length
        if (this.bytes! > this.maxBytes) this.bytes! -= evictCas(this, this.maxBytes)
      }
    }
    return sha
  }
  *entries(): IterableIterator<{ sha: string; size: number; atime: number }> {
    if (!existsSync(casDir())) return
    for (const sha of readdirSync(casDir())) {
      if (!SHA256_HEX.test(sha)) continue
      const st = statSync(casPath(sha))
      yield { sha, size: st.size, atime: st.atimeMs }
    }
  }
  delete(sha: string): void {
    const p = casPath(sha)
    if (existsSync(p)) unlinkSync(p)
  }
}

function casDir(): string { return join(homedir(), ".jemacs", "cas") }
function scanCasBytes(): number {
  let n = 0
  if (!existsSync(casDir())) return 0
  for (const name of readdirSync(casDir())) if (SHA256_HEX.test(name)) n += statSync(join(casDir(), name)).size
  return n
}

/** When total bytes exceed `maxBytes`, delete oldest-atime entries until at or
 *  under `0.8 × maxBytes`. Returns bytes freed. The 0.8 hysteresis stops every
 *  write from triggering a fresh scan once at the cap. */
export function evictCas(cas: EvictableCas, maxBytes: number): number {
  const all = [...cas.entries()]
  let total = all.reduce((n, e) => n + e.size, 0)
  if (total <= maxBytes) return 0
  all.sort((a, b) => a.atime - b.atime)
  const target = Math.floor(maxBytes * 0.8)
  let freed = 0
  for (const e of all) {
    if (total <= target) break
    cas.delete(e.sha)
    total -= e.size
    freed += e.size
  }
  return freed
}

/** Module-level convenience matching the task's casLookup/casWrite shape. */
const fileCas = new FileCas()
export function casLookup(sha: string): string | undefined { return fileCas.lookup(sha) }
export function casWrite(text: string, maxBytes?: number): string {
  const sha = fileCas.write(text)
  if (maxBytes !== undefined) evictCas(fileCas, maxBytes)
  return sha
}

// ── Diff ────────────────────────────────────────────────────────────────────

/**
 * Line-based LCS diff: produce the minimal sequence of splices that, applied to
 * `from` in order, yields `to`. Used by A on `Have{cachedSha}` to ship the
 * stale→current correction as a `rebase{ops}` (DESIGN.md §Content-addressed).
 *
 * Works at line granularity (Myers-equivalent for typical edits) so two distant
 * changes become two small splices instead of one giant middle replace. Within
 * a changed line run, the splice is the whole run — no intra-line diffing.
 *
 * Splices are returned in *post-application* coordinates: each `from`/`to` is
 * relative to the text after the preceding splices have been applied, which is
 * what `BufferModel.splice` and the rebase path expect.
 */
export function diffText(from: string, to: string, bufferId: string): Splice[] {
  if (from === to) return []
  // splitLines: keep the trailing "\n" attached to each line so concatenation
  // round-trips and offsets are exact. "" → [].
  const a = splitLines(from)
  const b = splitLines(to)
  const n = a.length, m = b.length

  // LCS length table. O(n·m) — fine for buffer-sized inputs; rsync-style
  // rolling-hash delta is the deferred follow-up per DESIGN.md.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? 1 + dp[i + 1]![j + 1]! : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  // Walk the table, emitting splices for each maximal (delete-run, insert-run) pair.
  const ops: Splice[] = []
  let i = 0, j = 0, pos = 0 // pos = offset in the *current* (post-prior-splices) text
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { pos += a[i]!.length; i++; j++; continue }
    let delLen = 0, ins = ""
    while (i < n && (j >= m || a[i] !== b[j]) && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      delLen += a[i]!.length; i++
    }
    while (j < m && (i >= n || a[i] !== b[j])) { ins += b[j]!; j++ }
    ops.push({ kind: "splice", bufferId, from: pos, to: pos + delLen, text: ins, seq: 0 })
    pos += ins.length
  }
  return ops
}

function splitLines(s: string): string[] {
  if (s === "") return []
  const out = s.split("\n")
  // Re-attach the "\n" to every segment except the last; if s ends in "\n",
  // split gives a trailing "" which we drop (the "\n" went onto the prior line).
  for (let i = 0; i < out.length - 1; i++) out[i] += "\n"
  if (out[out.length - 1] === "") out.pop()
  return out
}

// ── Chunking ────────────────────────────────────────────────────────────────

/** Split `text` into ≤`size`-char chunks for streaming after a `Want`. The last
 *  chunk (only) carries `eof: true`. Empty text → one empty eof chunk. */
export function chunkText(id: string, text: string, size = 64 * 1024): Chunk[] {
  if (text.length === 0) return [{ kind: "chunk", id, offset: 0, data: "", eof: true }]
  const out: Chunk[] = []
  for (let off = 0; off < text.length; off += size) {
    const data = text.slice(off, off + size)
    const chunk: Chunk = { kind: "chunk", id, offset: off, data }
    if (off + size >= text.length) chunk.eof = true
    out.push(chunk)
  }
  return out
}
