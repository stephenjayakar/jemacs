# Shadow — remote editing with local-feeling latency

Two `Editor` instances: **A** (authority, server) and **S** (shadow, your laptop). S applies edits optimistically and renders immediately; A is the truth. Ops, not snapshots, go over the wire. When A's truth diverges from S's prediction, S rebases.

## Ops

```ts
type Seq = number  // monotone per (peerId)
type Splice = { kind: "splice"; bufferId: string; from: number; to: number; text: string; seq: Seq }
type Point  = { kind: "point";  bufferId: string; point: number; seq: Seq }
type Buffer = { kind: "buffer"; id: string; path?: string; text: string; mode: string }
type Layout = { kind: "layout"; tree: WindowNode }
type Cmd    = { kind: "command"; name: string; args: unknown[]; seq: Seq }   // S→A only, trust:"full" only
type Ack    = { kind: "ack"; upTo: Seq }
type Rebase = { kind: "rebase"; bufferId: string; baseSeq: Seq; ops: Splice[] }
type Lsp    = { kind: "lsp"; bufferId: string; diagnostics?: Diagnostic[]; hover?: string; completion?: Candidate[] }
type ShadowOp = Splice | Point | Buffer | Layout | Cmd | Ack | Rebase | Lsp
```

`Cmd` flows S→A only. A only ever sends `splice`/`point`/`buffer`/`layout`/`ack`/`rebase`/`lsp`. Enforced at `applyRemoteOp(link, op)` chokepoint.

## Link

```ts
interface ShadowLink {
  readonly peerId: string
  readonly trust: "full" | "propose"      // server-side per auth, never read from wire
  send(op: ShadowOp): void
  on(handler: (op: ShadowOp) => void): void
  close(): void
}
```

`BufferModel` gains `link?: ShadowLink`. A buffer with `link` set is remote — `save()` etc. route via `{command:...}` instead of local FS.

## Reconciliation

S keeps `pending: Splice[]` per buffer (ops sent, not yet ack'd). On `ack{upTo}`: drop pending with `seq ≤ upTo`. On `rebase{baseSeq, ops}`:

1. Rewind buffer to `baseSeq` via op-log undo (walk parent pointers).
2. Apply A's `ops`.
3. Transform each pending op with `seq > baseSeq` by A's ops (offset shift — same as `_splice`'s mark-adjust), re-apply.
4. `pending` is now relative to A's new tip.

The transform: for pending op at `[from,to)` and A's op `[aFrom,aTo)→aText`: if `to ≤ aFrom`, no change. If `from ≥ aTo`, shift by `aText.length - (aTo - aFrom)`. If they overlap, the pending op is *invalidated* (its target text changed) — drop it and re-render so the user sees their edit didn't survive.

## Speculative rendering

`buffer.locals["shadow-pending"]: Splice[]`. The display layer renders the *applied* text (S already has it), but maps pending ranges to `face: "shadow-pending"` (dim). Modeline: `[⇅ 3]` when `pending.length > 0`, `[✓]` when 0, `[⊘ partition]` when `link.partitioned`.

## Determinism (for DST)

`_splice` is already deterministic. Leaks to plug: `crypto.randomUUID()` in `BufferModel` constructor (sim passes explicit ids); `Date.now()` in any op path (none currently).

## DST simulator

`FakeLink implements ShadowLink` with `inflight: ShadowOp[]`, `partitioned: boolean`, `tick(n)` delivers up to n ops subject to `reorder`/`drop`/`dup`/`delay` adversary. `Simulator(seed)` owns A, S, baseline (single-proc oracle), FakeLink, seeded PRNG. Property after `link.drain()`: `A.buffers ≡ S.buffers ≡ baseline.buffers`.

## Content-addressed buffer sync

Opening a file shouldn't ship the whole text if S already has it.

```ts
type BufferRef = { kind: "buffer"; id: string; path?: string; sha: string; mode: string }   // no text
type Have      = { kind: "have"; id: string; sha: string }   // S→A: I have this content
type Want      = { kind: "want"; id: string }                // S→A: send me the text
type Chunk     = { kind: "chunk"; id: string; offset: number; data: string; eof?: true }
```

A sends `BufferRef` first. S checks `~/.jemacs/cas/<sha>` and its local `path`:
- **Hit** → render instantly from cache, send `Have{sha}`. Zero text bytes.
- **Stale** (have *a* version, wrong sha) → render the stale version immediately with `[⊘ syncing]`, send `Have{cachedSha}`. A diffs `cachedSha`→`sha` (via git or its own CAS) and sends as `rebase{ops}`. First paint instant; correction is a small diff.
- **Miss** → send `Want`, A streams `Chunk`s.

CAS is `~/.jemacs/cas/<sha256(text)>`, populated on every received `Chunk` set and every local save. Prune by atime.

The stale case is the same rebase machinery — S's "prediction" is its cached text, A's "truth" is current, reconcile as usual. No new convergence logic.

Deferred: rsync-style block delta for the "neither side has the other's exact content" case. Cache-hit covers reconnect + same-checkout-locally, which is most of the value.

## Filesystem replica (phase 6 — after shadow-browser)

The CAS (`BufferRef`/`Have`/`Want`/`Chunk`) handles "open a file I've seen
before." The full local-FS-replica adds a **manifest** so navigation
(`find-file`, `dired`, `project-find-file`) is local too.

### Manifest

`{path → {sha, mode, size, mtime}}`, dirs hash their sorted children — a
Merkle tree, i.e., git's tree objects. For a git-tracked project, A's initial
manifest *is* `git ls-tree -r HEAD` plus the working-tree dirty set.

```ts
type ManifestEntry  = { path: string; sha: string; mode: number; size: number; mtime: number }
type ManifestTree   = { kind: "manifest-tree"; root: string; dir: string; entries: ManifestEntry[] }
type ManifestDelta  = { kind: "manifest-delta"; changes: Array<{path: string; old?: string; new?: ManifestEntry}> }
type ManifestReq    = { kind: "manifest-req"; dir: string }   // S → A: send me this subtree
```

On connect: A sends root hash. S compares to cached root → same: done.
Different: walk down, request only changed subtrees.

### Ops table

| op | S | A | feel |
|---|---|---|---|
| `find-file` | manifest → sha → CAS hit → render; miss → placeholder + `Want` | streams chunks | instant if seen; spinner if new |
| `dired` | render from manifest | sends mtimes/perms | instant; details fill in |
| `save-buffer` | CAS write + manifest update + `[⊘ saving]` | actual write, ack or error | instant; `[✓]`/`[⚠]` follows |
| `project-find-file` | filter manifest, no RTT | — | instant |
| `compile`/`grep`/`M-!` | show CAS(cmd+cwd) stale + `[⊘ re-running]` | run, stream | instant-stale → fresh |
| LSP | — | runs server | RTT-bound |

`platform/runtime`'s `readFile`/`stat`/`readdir` consult manifest+CAS first,
fall back to `{command:...}` over the link. `writeFile` is write-through with
async ack. Same rebase machinery handles stale-base saves
(`verifyVisitedFileModtime` already does this).

### Scaling to large repos

**Change discovery needs watchman.** Polling `stat` on 60k dirs doesn't work.
A's manifest-delta push is fed by a watchman subscription (the
`plugins/lsp-watchman` cursor pattern, repointed at the manifest instead of
LSP). Without watchman, fall back to per-`find-file` modtime checks — correct
but no proactive `auto-revert`. `defcustom shadow-manifest-watcher` =
`"watchman" | "poll" | "none"`.

**Lazy manifest.** Don't ship the whole tree on connect. Ship root hash + dirs
S has visited. `dired`/`find-file` on a new dir → `ManifestReq` for that
subtree. A 6M-entry repo costs one root hash + the subtrees you actually
touch. This is git's partial-clone shape.

**Bounded CAS.** `~/.jemacs/cas/` capped at `defcustom cas-max-bytes` (default
2 GiB). Evict by atime: each `casWrite` that crosses the cap walks the dir
sorted by atime and unlinks until under `cas-max-bytes × 0.8`. Manifest
entries stay (they're tiny); only blob content evicts. For git-tracked
projects, **`.git/objects` is a free second-tier CAS** — `casLookup(sha)`
checks `~/.jemacs/cas/` first, then `git cat-file -p <sha>` against the local
checkout, then `Want`.

**Manifest itself can be large.** Store it as a packed file
(`~/.jemacs/manifest/<root-sha>.pack`, sorted by path, mmap'd) not an
in-memory Map. `project-find-file` does a prefix scan; `dired` does a range
read. Same access pattern as git's pack index.

### fsRoot jail and symlinks

`AuthorityFs` jails `want`/`manifest-req` to `fsRoot` via `resolve()` prefix
check. This is **symlink-permeable**: a symlink inside the project that
targets outside it will be followed. Same as git (`git add` follows
in-worktree symlinks). This is correct for the single-user model (you put the
symlink there; and the link's `{command:"spawn"}` is full RCE anyway). For a
hypothetical multi-tenant A where untrusted projects share a host, swap in a
`realpath()`-based check — but that breaks intentional symlinks (vendored
deps, bazel-out, `packages/jemacs-core/*`), so it's not the default.

### Coherence failure modes

- A's watcher misses a change → S stale until next full root-hash check
  (heartbeat every `shadow-manifest-resync-interval`, default 60s).
- S edits a stale-cached file → caught at save by `verifyVisitedFileModtime`
  on A; prompts as today.
- Network partition during save → S's CAS has the content; on reconnect,
  `resendPending` includes the write command; A applies or conflicts.

## Transport (generic)

`ShadowLink` is the interface; transports are implementations:

| transport | impl | use |
|---|---|---|
| `StdioLink` | subprocess stdin/stdout, length-prefixed JSON | **primary remote** — `ssh host jemacs --serve-stdio` |
| `WsLink` | `ws://127.0.0.1:port` + token | attach a second S to an already-running A |
| `FakeLink` | in-process queue | DST |

`shadow-connect` takes a URI: `ssh://user@host[/path]`, `ws://host:port`, `stdio:CMD`. It picks the transport, establishes the link, calls `attachShadow`.

## Self-install (VSCode Remote-style)

`shadow-connect ssh://host` does, in order:

1. `ssh host 'test -x ~/.jemacs/bin/jemacs-$VERSION'` — if present, skip to 4.
2. `ssh host 'curl -fsSL https://bun.sh/install | bash'` (if `bun` missing).
3. `scp` (or `ssh cat | tar x`) the local jemacs bundle to `~/.jemacs/bin/jemacs-$VERSION/`. Version-pinned so client/server protocol always matches.
4. `ssh host '~/.jemacs/bin/jemacs-$VERSION/jemacs --serve-stdio'` → `StdioLink` over the ssh process.

The bundle is `bun build --compile` output (single binary) or a tarball of `src/`+`lisp/`+`plugins/`+`node_modules` if compile isn't ready. `$VERSION` = `git rev-parse --short HEAD` so a mismatch is impossible.

## LSP bootstrap on A

A's `lsp/clients/*.ts` already gate on `which <server>`. On miss, instead of silently disabling: `editor.message("<server> not on remote — M-x lsp-install-server")`. `lsp-install-server` (per-client) runs the idiomatic installer on A: `rustup component add rust-analyzer`, `go install golang.org/x/tools/gopls@latest`, `bun add -g typescript-language-server`. The command runs on A (it's a normal `{command:...}` from S); output streams back into `*lsp-install*`.

## Local play + integration (after DST is green)

`WsLink implements ShadowLink` over a `ws://127.0.0.1:port` socket. `M-x shadow-serve` (A) prints a one-time token + port; `M-x shadow-connect HOST:PORT TOKEN` (S) handshakes and attaches.

Local play: two jemacs in side-by-side tmux panes, `shadow-serve` left, `shadow-connect` right, type in right and watch left converge. `scripts/shadow-pair.sh` spawns both.

Integration test (`test/shadow/integration.test.ts`, `JEMACS_SKIP_TUI`-gated): spawn two real `bun run src/main.ts` processes via tmux, drive S with `tui-drive.sh keys`, assert A's buffer text matches via a `--dump-buffer` CLI flag. This is the layer-3 proof — real socket, real processes, real keystrokes.

## Plugin remote-awareness

Plugins that spawn subprocesses or touch FS check `buffer.link`:
- `compile`/`magit`/`project`: send `{command: name, args}` to A; output streams back as splice on `*compilation*`/`*magit*` (which A creates and `{kind:"buffer"}`-sends).
- `term`: pty on A; `term-send-raw` → `{command}`; output → splice.
- `lsp-*`: `editor.lsp` for remote buffers is a stub that sends `{command:"lsp-*"}` and resolves on `{kind:"lsp"}`.
- `auto-save`/`persist`: skip remote buffers (A owns persistence).
