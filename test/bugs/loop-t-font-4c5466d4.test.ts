import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bundleIsStale } from "../../src/web/host"

let dir = ""

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ""
})

// t-font-4c5466d4: WebHost.create only checked existsSync(editor.js), so a
// source edit after the first build served the stale bundle until the user
// blew away dist/. The check now walks the source roots for any mtime newer
// than the bundle's.
test("bundleIsStale: source newer than bundle → 'stale'; rebuilt bundle → 'fresh'", async () => {
  dir = await mkdtemp(join(tmpdir(), "jemacs-stale-"))
  await mkdir(join(dir, "src/sub"), { recursive: true })
  const bundle = join(dir, "out.js")
  const src = join(dir, "src/sub/a.ts")
  await writeFile(src, "x")
  await writeFile(bundle, "bundle")
  // Backdate the bundle so the source is unambiguously newer.
  const past = new Date(Date.now() - 60_000)
  await utimes(bundle, past, past)
  expect(await bundleIsStale(bundle, [join(dir, "src")])).toBe("stale")
  // Rebuild touches the bundle → fresh again.
  await writeFile(bundle, "rebuilt")
  expect(await bundleIsStale(bundle, [join(dir, "src")])).toBe("fresh")
})

test("bundleIsStale: missing bundle → 'missing'", async () => {
  dir = await mkdtemp(join(tmpdir(), "jemacs-stale-"))
  await mkdir(join(dir, "src"), { recursive: true })
  await writeFile(join(dir, "src/a.ts"), "x")
  expect(await bundleIsStale(join(dir, "out.js"), [join(dir, "src")])).toBe("missing")
})

test("bundleIsStale: missing source roots degrade to existence-only", async () => {
  dir = await mkdtemp(join(tmpdir(), "jemacs-stale-"))
  await writeFile(join(dir, "out.js"), "bundle")
  // Installed JEMACS_HOME layouts may ship dist/ without src/.
  expect(await bundleIsStale(join(dir, "out.js"), [join(dir, "nope")])).toBe("fresh")
})
