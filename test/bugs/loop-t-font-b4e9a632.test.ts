/**
 * t-font-b4e9a632: build-shadow-web.ts auto-runs fetch-fonts.sh when
 * src/web/fonts/ has no .woff2 (the fresh-clone state — only LICENSE files
 * are committed). Tests the trigger predicate via an injected `run`; never
 * touches the network.
 */
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureFonts } from "../../scripts/build-shadow-web"

const tmps: string[] = []
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "jemacs-fonts-"))
  tmps.push(d)
  return d
}
afterEach(async () => {
  while (tmps.length) await rm(tmps.pop()!, { recursive: true, force: true })
})

function recorder(code = 0): { calls: string[]; run: (s: string) => Promise<number> } {
  const calls: string[] = []
  return { calls, run: async s => (calls.push(s), code) }
}

test("fresh clone (only LICENSE txt, no woff2) → runs fetch-fonts.sh", async () => {
  const dir = await tmp()
  await writeFile(join(dir, "Inter-LICENSE.txt"), "x")
  await writeFile(join(dir, "JetBrainsMono-LICENSE.txt"), "x")
  const r = recorder()
  expect(await ensureFonts(dir, r.run)).toBe("fetched")
  expect(r.calls.length).toBe(1)
  expect(r.calls[0]).toMatch(/fetch-fonts\.sh$/)
})

test("woff2 present → skips fetch", async () => {
  const dir = await tmp()
  await writeFile(join(dir, "JetBrainsMono-Regular.woff2"), "x")
  const r = recorder()
  expect(await ensureFonts(dir, r.run)).toBe("ok")
  expect(r.calls.length).toBe(0)
})

test("missing dir treated as empty → runs fetch", async () => {
  const r = recorder()
  expect(await ensureFonts(join(tmpdir(), "jemacs-fonts-nonexistent-" + Date.now()), r.run)).toBe("fetched")
  expect(r.calls.length).toBe(1)
})

test("propagates non-zero exit from fetch-fonts.sh", async () => {
  const dir = await tmp()
  const r = recorder(1)
  await expect(ensureFonts(dir, r.run)).rejects.toThrow(/exited 1/)
})
