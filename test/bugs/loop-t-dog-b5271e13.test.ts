import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { resolveFsRoot } from "../../src/main"

// t-dog-b5271e13: `--web --shadow <file>` with <file> outside cwd left WebHost
// jailed at process.cwd() (host.ts default), so the shadow client's find-file
// on <file> hit the jail and got an empty manifest. Fix: parse --fsRoot, and
// when absent default it to projectRoot(first file argv) — falling back to that
// file's dirname — so the jail follows the file you actually opened.

test("main.ts: --fsRoot parsed and threaded to createWebHost", async () => {
  const src = await readFile(join(import.meta.dirname, "../../src/main.ts"), "utf8")
  expect(src).toMatch(/--fsRoot/)
  expect(src).toMatch(/createWebHost\(\{[^}]*\bfsRoot\b/s)
})

test("resolveFsRoot: explicit > projectRoot(file) > dirname(file) > undefined", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "jemacs-b527-"))
  try {
    const proj = join(scratch, "proj")
    mkdirSync(join(proj, "src"), { recursive: true })
    writeFileSync(join(proj, "package.json"), "{}")
    const inProj = join(proj, "src", "a.ts")
    const bare = join(scratch, "bare", "x.txt")
    mkdirSync(dirname(bare))

    expect(await resolveFsRoot("/explicit/root", inProj)).toBe(resolve("/explicit/root"))
    expect(await resolveFsRoot(undefined, inProj)).toBe(proj)
    expect(await resolveFsRoot(undefined, bare)).toBe(dirname(bare))
    expect(await resolveFsRoot(undefined, undefined)).toBeUndefined()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
