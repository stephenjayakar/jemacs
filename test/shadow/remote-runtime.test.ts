import { describe, expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { MemCas, sha256 } from "../../src/shadow/cas"
import { type FsLike, ManifestCache } from "../../src/shadow/manifest"
import type { ManifestEntry, ShadowOp } from "../../src/shadow/ops"
import { createAuthorityFs, createRemoteRuntime } from "../../src/shadow/remote-runtime"
import { attachAuthority, attachShadow } from "../../src/shadow/shadow"
import { FakeFs, S_IFDIR, dirname } from "./fake-fs"
import { FakeLink } from "./fake-link"
import { SeededRng } from "./sim"

function fsLike(fs: FakeFs): FsLike {
  return {
    stat: p => { const s = fs.stat(p); return { mode: s.mode, size: s.content.length, mtime: s.mtime } },
    readdir: d => fs.readdir(d),
    readFile: p => fs.readFile(p),
  }
}

function seed(fs: FakeFs, tree: Record<string, string>): void {
  for (const [p, c] of Object.entries(tree)) {
    fs.mkdir(dirname(p), { recursive: true })
    fs.writeFile(p, c)
  }
}

/** Drain both directions until quiescent. `setTimeout(0)` flushes the microtask
 *  chain inside `createAuthorityFs.listDir` (one `await` per child stat/read). */
async function settle(a: FakeLink, s: FakeLink): Promise<void> {
  for (let idle = 0; idle < 2; ) {
    const n = a.drain() + s.drain()
    await new Promise(r => setTimeout(r, 0))
    idle = n === 0 && a.inflight.length === 0 && s.inflight.length === 0 ? idle + 1 : 0
  }
}

/** Hand-wired pair: A serves FakeFs via `createAuthorityFs`, S is a bare
 *  `RemoteRuntime`. No `Editor` on either side — isolates the runtime. */
function handWired(tree: Record<string, string>) {
  const fs = new FakeFs()
  seed(fs, tree)
  const { sLink, aLink } = FakeLink.pair()
  const aRecv: ShadowOp[] = []
  const afs = createAuthorityFs(aLink, fsLike(fs))
  aLink.on(op => { aRecv.push(op); afs.onOp(op) })

  const cas = new MemCas()
  const runtime = createRemoteRuntime(sLink, new ManifestCache(), cas)
  sLink.on(op => runtime.onOp(op))

  const received = (kind: ShadowOp["kind"]) => aRecv.filter(o => o.kind === kind)
  return { fs, afs, sLink, aLink, runtime, cas, aRecv, received }
}

// ── readFile: manifest → sha → CAS, with Want fallback ──────────────────────

describe("RemoteRuntime.readFileText", () => {
  test("first read fetches over the link; second read is a CAS hit (zero Wants)", async () => {
    const h = handWired({ "/src/a.ts": "export const a = 1\n", "/src/b.ts": "b" })

    const p1 = h.runtime.readFileText("/src/a.ts")
    await settle(h.aLink, h.sLink)
    expect(await p1).toBe("export const a = 1\n")
    // One ManifestReq for /src, one Want for /src/a.ts.
    expect(h.received("manifest-req").length).toBe(1)
    expect(h.received("want").length).toBe(1)
    // Landed in S's CAS under the manifest's sha.
    expect(h.cas.lookup(sha256("export const a = 1\n"))).toBe("export const a = 1\n")

    h.aRecv.length = 0
    const p2 = h.runtime.readFileText("/src/a.ts")
    await settle(h.aLink, h.sLink)
    expect(await p2).toBe("export const a = 1\n")
    // Manifest already loaded + CAS hit ⇒ nothing crosses the link.
    expect(h.aRecv).toEqual([])
  })

  test("ENOENT → throws (so the user sees the miss instead of a silent-empty buffer)", async () => {
    const h = handWired({ "/x.txt": "x" })
    const p = h.runtime.readFileText("/nope.txt").catch(e => e)
    await settle(h.aLink, h.sLink)
    expect((await p as { code?: string }).code).toBe("ENOENT")
    expect(await h.runtime.fileExists("/nope.txt")).toBe(false)
    expect(await h.runtime.fileExists("/x.txt")).toBe(true)
  })

  test("concurrent reads of one path coalesce to one ManifestReq + one Want", async () => {
    const h = handWired({ "/a.txt": "hello" })
    const [r1, r2, r3] = [h.runtime.readFileText("/a.txt"), h.runtime.readFileText("/a.txt"), h.runtime.readFileText("/a.txt")]
    await settle(h.aLink, h.sLink)
    expect(await r1).toBe("hello")
    expect(await r2).toBe("hello")
    expect(await r3).toBe("hello")
    expect(h.received("manifest-req").length).toBe(1)
    expect(h.received("want").length).toBe(1)
  })
})

// ── readdir / stat: lazy ManifestReq ────────────────────────────────────────

describe("RemoteRuntime.readdir", () => {
  test("unknown dir → exactly one ManifestReq, then served from cache", async () => {
    const h = handWired({ "/src/a.ts": "a", "/src/b.ts": "b", "/lib/u.ts": "u" })

    expect(h.runtime.manifest.has("/src")).toBe(false)
    const p = h.runtime.readdir!("/src")
    // Request is enqueued synchronously, before any await.
    expect(h.aLink.inflight.map(i => i.op)).toEqual([{ kind: "manifest-req", dir: "/src" }])

    await settle(h.aLink, h.sLink)
    expect(await p).toEqual(["a.ts", "b.ts"])
    expect(h.received("manifest-req")).toEqual([{ kind: "manifest-req", dir: "/src" }])
    expect(h.runtime.manifest.has("/src")).toBe(true)

    // Second readdir on the now-loaded dir: no further ManifestReq.
    h.aRecv.length = 0
    expect(await h.runtime.readdir!("/src")).toEqual(["a.ts", "b.ts"])
    expect(h.received("manifest-req")).toEqual([])
    // /lib was never visited → still lazy.
    expect(h.runtime.manifest.has("/lib")).toBe(false)
  })

  test("stat returns mode/size/mtime from the manifest; dirs marked S_IFDIR", async () => {
    const h = handWired({ "/d/f.txt": "abc" })
    const ps = h.runtime.stat!("/d/f.txt")
    await settle(h.aLink, h.sLink)
    const st = (await ps)!
    expect(st.size).toBe(3)
    expect(st.mode & S_IFDIR).toBe(0)

    // The /d entry lives in /'s listing.
    const pd = h.runtime.stat!("/d")
    await settle(h.aLink, h.sLink)
    expect((await pd)!.mode & S_IFDIR).toBeTruthy()
  })
})

// ── writeFile: CAS + Cmd + optimistic manifest ──────────────────────────────

describe("RemoteRuntime.writeFileText", () => {
  test("writes CAS, ships {command:write-file}, patches manifest optimistically", async () => {
    const h = handWired({ "/a.txt": "old" })
    // Load / first so the optimistic delta has a listing to land in.
    void h.runtime.readdir!("/")
    await settle(h.aLink, h.sLink)
    h.aRecv.length = 0

    await h.runtime.writeFileText("/a.txt", "new text")
    expect(h.cas.lookup(sha256("new text"))).toBe("new text")
    await settle(h.aLink, h.sLink)
    const cmds = h.received("command")
    expect(cmds.length).toBe(1)
    expect((cmds[0] as { name: string; args: unknown[] }).name).toBe("write-file")
    // Following stat sees the new sha without a round-trip.
    const e = h.runtime.manifest.lookup("/a.txt") as ManifestEntry
    expect(e.sha).toBe(sha256("new text"))
  })
})

// ── A-side watcher → ManifestDelta ──────────────────────────────────────────

describe("AuthorityFs.watch", () => {
  test("fs change → ManifestDelta lands in S's cache for loaded dirs", async () => {
    const h = handWired({ "/w/a.txt": "v1" })
    const stop = h.afs.watch(handler => h.fs.onChange(c => handler(c)))
    void h.runtime.readdir!("/w")
    await settle(h.aLink, h.sLink)
    expect((h.runtime.manifest.lookup("/w/a.txt") as ManifestEntry).sha).toBe(sha256("v1"))

    h.fs.writeFile("/w/a.txt", "v2")
    await settle(h.aLink, h.sLink)
    expect((h.runtime.manifest.lookup("/w/a.txt") as ManifestEntry).sha).toBe(sha256("v2"))
    stop()
  })
})

// ── attach* wiring: same flow through real Editor + ShadowState ─────────────

describe("attachShadow/attachAuthority fs wiring", () => {
  test("S.readFileText via opts.runtime, A serves via opts.fs", async () => {
    const fs = new FakeFs()
    seed(fs, { "/p/main.ts": "console.log(1)\n" })
    const { sLink, aLink } = FakeLink.pair()

    const A = new Editor()
    const dA = attachAuthority(A, aLink, { fs: fsLike(fs), cas: new MemCas(), flushMs: 0 })

    const S = new Editor()
    const sCas = new MemCas()
    const runtime = createRemoteRuntime(sLink, new ManifestCache(), sCas)
    const dS = attachShadow(S, sLink, { runtime, cas: sCas })

    const p = runtime.readFileText("/p/main.ts")
    await settle(aLink, sLink)
    expect(await p).toBe("console.log(1)\n")
    // setPlatformRuntime was installed: editor-level fileExists routes through it.
    const { fileExists } = await import("../../src/platform/runtime")
    const pe = fileExists("/p/main.ts")
    await settle(aLink, sLink)
    expect(await pe).toBe(true)

    dS(); dA()
  })
})

describe("AuthorityFs path jail", () => {
  test("want/manifest-req outside fsRoot return empty (no traversal)", async () => {
    const fs = new FakeFs()
    fs.mkdir("/proj"); fs.mkdir("/etc")
    fs.writeFile("/proj/ok.txt", "allowed")
    fs.writeFile("/etc/secret", "DENIED")
    const { sLink, aLink } = FakeLink.pair({ rng: new SeededRng(1) })
    const sent: ShadowOp[] = []
    sLink.on(op => sent.push(op))
    const afs = createAuthorityFs(aLink, fsLike(fs), "/proj")
    aLink.on(op => afs.onOp(op))

    sLink.send({ kind: "want", id: "/etc/secret" })
    sLink.send({ kind: "want", id: "/proj/../etc/secret" })
    sLink.send({ kind: "manifest-req", dir: "/etc" })
    sLink.send({ kind: "want", id: "/proj/ok.txt" })
    await settle(sLink, aLink)

    const chunks = sent.filter(o => o.kind === "chunk") as Extract<ShadowOp, {kind:"chunk"}>[]
    expect(chunks.find(c => c.id === "/etc/secret")?.data).toBe("")
    expect(chunks.find(c => c.id === "/proj/../etc/secret")?.data).toBe("")
    expect(chunks.find(c => c.id === "/proj/ok.txt")?.data).toBe("allowed")
    const trees = sent.filter(o => o.kind === "manifest-tree") as Extract<ShadowOp, {kind:"manifest-tree"}>[]
    expect(trees.find(t => t.dir === "/etc")?.entries).toEqual([])
  })
})
