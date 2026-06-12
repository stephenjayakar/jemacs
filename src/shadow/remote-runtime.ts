import type { PlatformRuntime, SpawnHandle, SpawnOptions, StatLike, WatchHandle } from "../platform/runtime"
import type { ShadowLink } from "./link"
import type { Chunk, ManifestDelta, ManifestEntry, ManifestTree, Seq, ShadowOp } from "./ops"
import { resolve, sep } from "node:path"
import { type Cas, chunkText, sha256 } from "./cas"
import { buildManifest, diffManifest, dirname, type FsLike, type Lookup, type Manifest, ManifestCache } from "./manifest"

const S_IFDIR = 0o040000
const S_IFREG = 0o100644
const isDir = (mode: number) => (mode & S_IFDIR) !== 0
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1)
const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`)

// ── S-side: manifest+CAS-backed PlatformRuntime ─────────────────────────────

/** A `PlatformRuntime` plus the hooks `attachShadow` needs to feed it inbound
 *  ops and share the seq counter. */
export type RemoteRuntime = PlatformRuntime & {
  readonly manifest: ManifestCache
  /** Feed an inbound op (manifest-tree/manifest-delta/chunk). Returns true if
   *  consumed — lets `onShadowOp` skip its own buffer-chunk path. */
  onOp(op: ShadowOp): boolean
  /** Rebind the seq allocator so `Cmd` ops share `ShadowState.nextSeq` (A's
   *  reliability layer requires one monotone counter across splice/point/cmd). */
  bindSeq(next: () => Seq): void
}

/**
 * The phase-6 `PlatformRuntime` (DESIGN.md §Filesystem replica): every fs/spawn
 * call consults `manifest`+`cas` first and falls back to a link round-trip.
 *
 * Read path: `stat`/`readdir` → manifest (lazy `ManifestReq` on miss);
 * `readFileText` → manifest sha → CAS (lazy `Want` on miss). Second read of the
 * same content is a CAS hit, zero link bytes.
 *
 * Write path: `writeFileText` writes the CAS, ships `{command:"write-file"}`,
 * and patches the manifest optimistically so a following `stat` sees the new
 * sha before A's watcher delta arrives. `spawnProcess` ships
 * `{command:"spawn"}` and returns a stub handle — output streams back as
 * splices on an A-created buffer, not through this handle.
 */
export function createRemoteRuntime(
  link: ShadowLink,
  manifest: ManifestCache,
  cas: Cas,
  opts: { root?: string; env?: Record<string, string | undefined>; home?: string } = {},
): RemoteRuntime {
  /** dir → resolvers waiting on that dir's ManifestTree. */
  const dirWaiters = new Map<string, Array<() => void>>()
  /** Want id → resolvers waiting on the assembled text. */
  const wantWaiters = new Map<string, Array<(text: string) => void>>()
  /** Chunk reassembly, same shape as ShadowState.partial but keyed by Want id. */
  const partial = new Map<string, { chunks: Map<number, string>; eofAt?: number }>()
  /** dir → child basenames. Mirrors `manifest`'s loaded dirs so `readdir` is
   *  O(children), not a full `manifest.entries()` scan. */
  const children = new Map<string, Set<string>>()
  /** path → {seq, prior}: writes S has applied to `manifest` but A hasn't
   *  confirmed via manifest-delta/tree. `prior` is the snapshot to roll back to. */
  const optimistic = new Map<string, { seq: Seq; prior: Lookup }>()
  /** A's project root, latched from `ManifestTree.root`. `opts.root` pins it. */
  let root = opts.root ?? "/"

  let seq: () => Seq = (() => { let n = 0; return () => ++n })()
  const sendCmd = (name: string, args: unknown[]): Seq => {
    const s = seq()
    link.send({ kind: "command", name, args, seq: s })
    return s
  }

  /** Mirror a delta into `children` (manifest itself is patched separately). */
  function indexDelta(delta: ManifestDelta): void {
    for (const c of delta.changes) {
      const kids = children.get(dirname(c.path))
      if (!kids) continue
      if (c.new) kids.add(basename(c.path))
      else kids.delete(basename(c.path))
    }
  }

  /** Revert one optimistic write to its captured prior state. */
  function rollback(path: string, prior: Lookup): void {
    if (prior === "unknown") return // dir wasn't loaded — applyDelta was a no-op
    const change = prior ? { path, new: prior } : { path }
    const delta: ManifestDelta = { kind: "manifest-delta", changes: [change] }
    manifest.applyDelta(delta)
    indexDelta(delta)
  }

  /** Resolve every waiter for `key` in `map` with `value`, then drop the entry. */
  function flush<T>(map: Map<string, Array<(v: T) => void>>, key: string, value: T): void {
    const list = map.get(key)
    if (!list) return
    map.delete(key)
    for (const w of list) w(value)
  }

  /** Ensure `dir`'s listing is in the manifest, requesting it if not. Coalesces
   *  concurrent callers onto one in-flight ManifestReq. */
  function ensureDir(dir: string): Promise<void> {
    if (manifest.has(dir)) return Promise.resolve()
    const inflight = dirWaiters.get(dir)
    if (!inflight) {
      const req = manifest.requestMissing(dir)
      if (req) link.send(req)
    }
    return new Promise(resolve => {
      let list = dirWaiters.get(dir)
      if (!list) dirWaiters.set(dir, list = [])
      list.push(resolve)
    })
  }

  async function stat(path: string): Promise<ManifestEntry | null> {
    let e = manifest.lookup(path)
    if (e === "unknown") {
      await ensureDir(dirname(path))
      e = manifest.lookup(path)
    }
    return e === "unknown" ? null : e
  }

  /** CAS hit → return; miss → Want over the link, assemble Chunks, write CAS. */
  async function fetch(id: string, sha: string): Promise<string> {
    const hit = cas.lookupAsync ? await cas.lookupAsync(sha) : cas.lookup(sha)
    if (hit !== undefined) return hit
    if (!wantWaiters.has(id)) link.send({ kind: "want", id })
    return new Promise(resolve => {
      let list = wantWaiters.get(id)
      if (!list) wantWaiters.set(id, list = [])
      list.push(text => { cas.write(text); resolve(text) })
    })
  }

  function onChunk(op: Chunk): boolean {
    if (!wantWaiters.has(op.id)) return false
    let p = partial.get(op.id)
    if (!p) partial.set(op.id, p = { chunks: new Map() })
    p.chunks.set(op.offset, op.data)
    if (op.eof) p.eofAt = op.offset
    if (p.eofAt === undefined) return true
    let text = "", at = 0
    for (;;) {
      const slice = p.chunks.get(at)
      if (slice === undefined) return true // gap — wait for the missing chunk
      text += slice
      if (at === p.eofAt) {
        partial.delete(op.id)
        flush(wantWaiters, op.id, text)
        return true
      }
      at += slice.length
    }
  }

  return {
    manifest,
    bindSeq(next) { seq = next },

    onOp(op) {
      switch (op.kind) {
        case "manifest-tree":
          if (op.root && opts.root === undefined) root = op.root
          manifest.applyTree(op)
          children.set(op.dir, new Set(op.entries.map(e => basename(e.path))))
          // A's listing is authoritative — any optimistic write in this dir is
          // now either confirmed (present in entries) or overwritten; either way
          // the snapshot is stale.
          for (const p of optimistic.keys()) if (dirname(p) === op.dir) optimistic.delete(p)
          flush(dirWaiters, op.dir, undefined)
          return true
        case "manifest-delta":
          manifest.applyDelta(op)
          indexDelta(op)
          for (const c of op.changes) optimistic.delete(c.path)
          return true
        case "ack":
          // A processed every cmd ≤ upTo. Any optimistic write still here got no
          // confirming delta — A rejected (or hasn't fired the watcher yet, in
          // which case the follow-up delta re-applies the right entry).
          for (const [path, w] of optimistic) {
            if (w.seq > op.upTo) continue
            optimistic.delete(path)
            rollback(path, w.prior)
          }
          return false // let attachShadow's own ack handler run too
        case "chunk":
          return onChunk(op)
        default:
          return false
      }
    },

    async stat(path): Promise<StatLike | null> {
      const e = await stat(path)
      return e ? { mode: e.mode, size: e.size, mtime: e.mtime } : null
    },

    async readdir(dir) {
      await ensureDir(dir)
      return [...(children.get(dir) ?? [])].sort()
    },

    async readFileText(path) {
      const e = await stat(path)
      if (!e) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" })
      if (isDir(e.mode)) return ""
      return fetch(path, e.sha)
    },

    async fileExists(path) {
      return (await stat(path)) !== null
    },

    async writeFileText(path, text) {
      const sha = cas.write(text)
      const cmdSeq = sendCmd("write-file", [path, text])
      // Snapshot before patching so A's reject can be rolled back. Repeated
      // writes to the same path keep the *first* prior — the last A-confirmed state.
      const prior = optimistic.get(path)?.prior ?? manifest.lookup(path)
      // Optimistic: a following stat/read sees this immediately. A's watcher
      // delta will overwrite with the authoritative mtime/mode when it arrives.
      const delta: ManifestDelta = {
        kind: "manifest-delta",
        changes: [{ path, new: { path, sha, mode: S_IFREG, size: text.length, mtime: Date.now() } }],
      }
      manifest.applyDelta(delta)
      indexDelta(delta)
      optimistic.set(path, { seq: cmdSeq, prior })
    },

    spawnProcess(options: SpawnOptions): SpawnHandle {
      sendCmd("spawn", [options.cmd, options.cwd ?? null])
      // Output streams back as splices on an A-owned `*compilation*`-style
      // buffer (DESIGN.md §Plugin remote-awareness), not via this handle.
      return {
        stdin: null, stdout: null, stderr: null,
        exited: Promise.resolve(null),
        kill: () => sendCmd("kill-spawn", [options.cmd]),
      }
    },

    whichExecutable: () => null,

    // ── PlatformRuntime structural members (no link round-trip) ─────────────
    // The shadow has no process of its own; cwd/env/homedir report what A told
    // us at attach time (or sensible defaults). `hash` is the same sha256 the
    // CAS keys on. `watch` is a no-op — fs change notification arrives as
    // ManifestDelta over the link, not via a local watcher.
    hash(text) { return sha256(text) },
    cwd() { return root },
    env(name) { return opts.env?.[name] },
    homedir() { return opts.home ?? root },
    watch(_path, _onChange): WatchHandle { return { close: () => {} } },
  }
}

// ── A-side: serve manifest + chunks from an FsLike ──────────────────────────

export type FsWatcher = (onChange: (change: { path: string }) => void) => () => void

export type AuthorityFs = {
  /** Handle one S→A op (`manifest-req` / `want`). Returns true if consumed so
   *  `onAuthorityOp` knows to skip its buffer-id `want` path. */
  onOp(op: ShadowOp): boolean
  /** Subscribe to `watcher`; on each change, diff against the previous full
   *  manifest and ship a `ManifestDelta`. Returns the unsubscribe. */
  watch(watcher: FsWatcher): () => void
}

/**
 * A's filesystem face on the link. `onOp` answers `manifest-req` with a
 * one-level listing (file shas computed; dir shas left empty — they aren't
 * CAS-keyed) and `want` by streaming `fs.readFile(id)` as chunks. `watch`
 * rebuilds the full manifest on each watcher event and ships the Merkle diff.
 */
export function createAuthorityFs(link: ShadowLink, fs: FsLike, root = "/"): AuthorityFs {
  let prev: Manifest | undefined

  // op.dir / op.id arrive from the wire (S-controlled). Jail them to `root` so
  // a client can't `want("/etc/shadow")` or `manifest-req("/")`. resolve()
  // collapses any `..`; symlinks inside the project are honored (you put them
  // there) — same model as git.
  const jailRoot = resolve(root)
  const jailPrefix = jailRoot.endsWith(sep) ? jailRoot : jailRoot + sep
  function underRoot(p: string): string | null {
    const r = resolve(p)
    return r === jailRoot || r.startsWith(jailPrefix) ? r : null
  }

  async function listDir(dir: string): Promise<ManifestTree> {
    const entries: ManifestEntry[] = []
    let names: string[] = []
    try { names = await fs.readdir(dir) } catch { /* ENOENT/ENOTDIR → empty */ }
    for (const name of names) {
      const path = join(dir, name)
      const st = await fs.stat(path)
      const sha = isDir(st.mode) ? "" : sha256(await fs.readFile(path))
      entries.push({ path, sha, mode: st.mode, size: st.size, mtime: st.mtime })
    }
    return { kind: "manifest-tree", root: jailRoot, dir, entries }
  }

  return {
    onOp(op) {
      switch (op.kind) {
        case "manifest-req": {
          const safe = underRoot(op.dir)
          if (!safe) { link.send({ kind: "manifest-tree", root: jailRoot, dir: op.dir, entries: [] }); return true }
          void listDir(safe).then(tree => link.send(tree))
          return true
        }
        case "want": {
          const safe = underRoot(op.id)
          if (!safe) { link.send({ kind: "chunk", id: op.id, offset: 0, data: "", eof: true }); return true }
          void Promise.resolve()
            .then(() => fs.readFile(safe))
            .catch(() => "")
            .then(text => { for (const c of chunkText(op.id, text)) link.send(c) })
          return true
        }
        default:
          return false
      }
    },

    watch(watcher) {
      let building = false
      const rebuild = async () => {
        if (building) return
        building = true
        try {
          const next = await buildManifest(fs, root)
          if (prev) {
            const delta = diffManifest(prev, next)
            if (delta.changes.length) link.send(delta)
          }
          prev = next
        } finally { building = false }
      }
      void rebuild() // seed `prev` so the first change has a base to diff against
      return watcher(() => void rebuild())
    },
  }
}
