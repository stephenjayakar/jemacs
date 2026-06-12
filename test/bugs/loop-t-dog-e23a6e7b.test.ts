import { expect, test } from "bun:test"
import { MemCas, sha256 } from "../../src/shadow/cas"
import { ManifestCache } from "../../src/shadow/manifest"
import type { ManifestEntry } from "../../src/shadow/ops"
import { createRemoteRuntime } from "../../src/shadow/remote-runtime"
import { FakeLink } from "../shadow/fake-link"

const S_IFREG = 0o100644
const entry = (path: string, text: string): ManifestEntry =>
  ({ path, sha: sha256(text), mode: S_IFREG, size: text.length, mtime: 1 })

// t-dog-e23a6e7b: stat returns null (path not in manifest / outside jail) →
// readFileText returned "" → find-file showed a silently empty buffer instead
// of surfacing the error in the echo area. Must reject with ENOENT.
test("RemoteRuntime.readFileText: missing path rejects with ENOENT, not silent \"\"", async () => {
  const { sLink } = FakeLink.pair()
  const runtime = createRemoteRuntime(sLink, new ManifestCache(), new MemCas())
  // "/" is loaded → lookup("/nope.txt") is a definitive null, not "unknown".
  runtime.onOp({ kind: "manifest-tree", root: "/", dir: "/", entries: [entry("/a.txt", "x")] })

  const err = await runtime.readFileText("/nope.txt").then(() => null, e => e as NodeJS.ErrnoException)
  expect(err).not.toBeNull()
  expect(err?.code).toBe("ENOENT")
  expect(err?.message).toContain("/nope.txt")
})
