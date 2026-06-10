import { beforeAll, describe, expect, test } from "bun:test"
import { sha256 } from "../../src/shadow/cas"

// Bun's test runtime has no `indexedDB`. Use `fake-indexeddb` if it's
// installed; otherwise the suite is skipped (the IdbCas code path is exercised
// by the shadow-bundle test loading the bundle anyway).
let hasIdb = typeof globalThis.indexedDB !== "undefined"
try {
  if (!hasIdb) {
    const auto = require("fake-indexeddb/auto")
    void auto
    hasIdb = typeof globalThis.indexedDB !== "undefined"
  }
} catch { /* not installed */ }

describe.skipIf(!hasIdb)("IdbCas", () => {
  let IdbCas: typeof import("../../src/web/idb-cas").IdbCas

  beforeAll(async () => {
    ;({ IdbCas } = await import("../../src/web/idb-cas"))
  })

  test("write → lookupAsync round-trips", async () => {
    const cas = new IdbCas()
    const text = "hello, indexed world\n"
    const sha = cas.write(text)
    expect(sha).toBe(sha256(text))
    expect(await cas.lookupAsync(sha)).toBe(text)
  })

  test("sync lookup is a constant miss", async () => {
    const cas = new IdbCas()
    const sha = cas.write("x")
    expect(cas.lookup(sha)).toBeUndefined()
    expect(await cas.lookupAsync(sha)).toBe("x")
  })

  test("lookupAsync miss returns undefined", async () => {
    const cas = new IdbCas()
    expect(await cas.lookupAsync("0".repeat(64))).toBeUndefined()
  })

  test("entriesAsync enumerates stored blobs", async () => {
    const cas = new IdbCas()
    const sha = cas.write("entries-probe")
    const all = await cas.entriesAsync()
    const hit = all.find(e => e.sha === sha)
    expect(hit?.size).toBe("entries-probe".length)
    await cas.delete(sha)
    expect((await cas.entriesAsync()).find(e => e.sha === sha)).toBeUndefined()
  })
})
