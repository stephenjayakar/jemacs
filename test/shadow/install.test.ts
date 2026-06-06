import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  bundlePath,
  ensureRemote,
  jemacsRev,
  probeBun,
  probeRemote,
  remoteDir,
  sshServeArgv,
  validateHost,
  type Run,
  type RunResult,
} from "../../src/shadow/install"

/** Scriptable `Run`: each call is matched against `script` (substring of joined
 *  argv) and the result returned; everything is recorded in `calls`. */
function fakeRun(script: Array<{ match: string; result?: Partial<RunResult> }>) {
  const calls: string[][] = []
  const run: Run = async argv => {
    calls.push(argv)
    const joined = argv.join(" ")
    for (const s of script) {
      if (joined.includes(s.match)) return { code: 0, stdout: "", stderr: "", ...s.result }
    }
    return { code: 0, stdout: "", stderr: "" }
  }
  return { run, calls }
}

describe("install primitives", () => {
  test("jemacsRev: JEMACS_REV env wins; otherwise a short hex-ish token", () => {
    process.env.JEMACS_REV = "abc123"
    expect(jemacsRev()).toBe("abc123")
    delete process.env.JEMACS_REV
    expect(jemacsRev()).toMatch(/^[0-9a-f]{4,}$|^dev$/)
  })

  test("remoteDir / bundlePath / sshServeArgv are rev-pinned", () => {
    expect(remoteDir("cafe")).toBe("~/.jemacs/bin/jemacs-cafe")
    expect(bundlePath("cafe")).toMatch(/dist\/jemacs-cafe\.tar\.gz$/)
    expect(sshServeArgv("box", "cafe")).toEqual([
      "ssh", "--", "box", "~/.jemacs/bin/jemacs-cafe/jemacs", "--serve-stdio",
    ])
  })

  test("validateHost rejects option-injection and metachars", () => {
    expect(validateHost("user@box.example:2222")).toBe("user@box.example:2222")
    expect(() => validateHost("-oProxyCommand=evil")).toThrow(/invalid host/)
    expect(() => validateHost("box; rm -rf /")).toThrow(/invalid host/)
    expect(() => sshServeArgv("-l root", "r")).toThrow(/invalid host/)
  })
})

describe("probeRemote / probeBun", () => {
  test("probeRemote: ssh test -x on the rev-pinned launcher", async () => {
    const hit = fakeRun([{ match: "test -x", result: { code: 0 } }])
    expect(await probeRemote("box", { rev: "r1", run: hit.run })).toBe(true)
    expect(hit.calls[0]).toEqual(["ssh", "--", "box", "test -x ~/.jemacs/bin/jemacs-r1/jemacs"])

    const miss = fakeRun([{ match: "test -x", result: { code: 1 } }])
    expect(await probeRemote("box", { rev: "r1", run: miss.run })).toBe(false)
  })

  test("probeBun: checks PATH and ~/.bun/bin fallback", async () => {
    const { run, calls } = fakeRun([{ match: "command -v bun", result: { code: 0 } }])
    expect(await probeBun("box", { run })).toBe(true)
    expect(calls[0]![3]).toContain("~/.bun/bin/bun")
  })
})

describe("ensureRemote", () => {
  const bundle = join(mkdtempSync(join(tmpdir(), "jemacs-bundle-")), "jemacs-r1.tar.gz")
  writeFileSync(bundle, "fake")

  test("probe hit → one ssh round-trip, returns serve argv", async () => {
    const { run, calls } = fakeRun([{ match: "test -x", result: { code: 0 } }])
    const argv = await ensureRemote("box", { rev: "r1", bundle, run })
    expect(calls.length).toBe(1)
    expect(argv).toEqual(["ssh", "--", "box", "~/.jemacs/bin/jemacs-r1/jemacs", "--serve-stdio"])
  })

  test("probe miss + bun present → ships bundle, skips bun install", async () => {
    const log: string[] = []
    const { run, calls } = fakeRun([
      { match: "test -x ~/.jemacs", result: { code: 1 } },
      { match: "command -v bun", result: { code: 0 } },
      { match: "tar xzf", result: { code: 0 } },
    ])
    const argv = await ensureRemote("box", { rev: "r1", bundle, run, log: m => log.push(m) })
    const joined = calls.map(c => c.join(" "))
    expect(joined.some(c => c.includes("bun.sh/install"))).toBe(false)
    expect(joined.some(c => c.includes("mkdir -p ~/.jemacs/bin/jemacs-r1"))).toBe(true)
    expect(joined.some(c => c.includes("tar xzf - -C ~/.jemacs/bin/jemacs-r1"))).toBe(true)
    expect(joined.some(c => c.includes(bundle))).toBe(true)
    expect(argv.at(-1)).toBe("--serve-stdio")
    expect(log.some(m => m.includes("shipping"))).toBe(true)
  })

  test("probe miss + bun missing → installs bun first", async () => {
    const { run, calls } = fakeRun([
      { match: "test -x ~/.jemacs", result: { code: 1 } },
      { match: "bun.sh/install", result: { code: 0 } },
      { match: "command -v bun", result: { code: 1 } },
      { match: "tar xzf", result: { code: 0 } },
    ])
    await ensureRemote("box", { rev: "r1", bundle, run })
    const joined = calls.map(c => c.join(" "))
    const bunIdx = joined.findIndex(c => c.includes("bun.sh/install"))
    const tarIdx = joined.findIndex(c => c.includes("tar xzf"))
    expect(bunIdx).toBeGreaterThan(-1)
    expect(bunIdx).toBeLessThan(tarIdx)
  })

  test("upload failure surfaces stderr", async () => {
    const { run } = fakeRun([
      { match: "test -x ~/.jemacs", result: { code: 1 } },
      { match: "command -v bun", result: { code: 0 } },
      { match: "tar xzf", result: { code: 1, stderr: "disk full" } },
    ])
    await expect(ensureRemote("box", { rev: "r1", bundle, run })).rejects.toThrow(/disk full/)
  })

  test("rejects invalid host before any subprocess", async () => {
    const { run, calls } = fakeRun([])
    await expect(ensureRemote("-oFoo", { rev: "r1", bundle, run })).rejects.toThrow(/invalid host/)
    expect(calls.length).toBe(0)
  })
})
