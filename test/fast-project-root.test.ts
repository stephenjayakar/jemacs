import { afterEach, describe, expect, test } from "bun:test"
import { addPathOnlyRoot, fastProjectRoot, findProjectRoot } from "../src/lsp/project-root"

/**
 * Core registers no patterns, so each test installs its own and removes it again. The
 * pattern shape here matches what a host or plugin supplies: an absolute path prefix
 * with the root captured in group 1.
 */
const MONOREPO = /^(.*\/monorepo)(\/|$)/

let dispose: (() => void) | null = null
afterEach(() => { dispose?.(); dispose = null })

function register(pattern: RegExp): void {
  dispose = addPathOnlyRoot(pattern)
}

describe("fastProjectRoot", () => {
  test("returns null when no pattern is registered", () => {
    expect(fastProjectRoot("/srv/checkout/monorepo/net/rpc/server.py")).toBeNull()
  })

  test("resolves a registered root from the path alone", () => {
    register(MONOREPO)
    expect(fastProjectRoot("/srv/checkout/monorepo/net/rpc/server.py"))
      .toBe("/srv/checkout/monorepo")
  })

  test("handles the root directory itself", () => {
    register(MONOREPO)
    expect(fastProjectRoot("/srv/checkout/monorepo")).toBe("/srv/checkout/monorepo")
  })

  test("takes the last boundary when a parent directory repeats the name", () => {
    register(MONOREPO)
    expect(fastProjectRoot("/srv/monorepo-exp/monorepo/foo/bar.cc"))
      .toBe("/srv/monorepo-exp/monorepo")
  })

  test("returns null outside the tree so the marker walk still runs", () => {
    register(MONOREPO)
    expect(fastProjectRoot("/Users/me/project/src/main.ts")).toBeNull()
  })

  test("does not match a directory merely prefixed with the root name", () => {
    register(MONOREPO)
    expect(fastProjectRoot("/Users/me/monorepostuff/main.ts")).toBeNull()
  })

  test("a disposed pattern stops matching", () => {
    const remove = addPathOnlyRoot(MONOREPO)
    expect(fastProjectRoot("/srv/checkout/monorepo/a.py")).toBe("/srv/checkout/monorepo")
    remove()
    expect(fastProjectRoot("/srv/checkout/monorepo/a.py")).toBeNull()
  })

  test("re-registering the same pattern replaces it, so a reload leaves one disposer", () => {
    // A plugin's `install` runs again on every hot reload. Stacking a duplicate would
    // leave a live pattern behind after the first disposer runs.
    addPathOnlyRoot(MONOREPO)
    const second = addPathOnlyRoot(/^(.*\/monorepo)(\/|$)/)
    second()
    expect(fastProjectRoot("/srv/checkout/monorepo/a.py")).toBeNull()
  })

  test("findProjectRoot short-circuits without touching the filesystem", async () => {
    register(MONOREPO)
    // This path does not exist; a marker walk would fall back to dirname. Getting the
    // registered root back proves the fast path ran instead.
    const root = await findProjectRoot("/srv/checkout/monorepo/a/b/c.py")
    expect(root).toBe("/srv/checkout/monorepo")
  })
})
