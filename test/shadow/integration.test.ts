/**
 * Layer-3 shadow proof: two real `bun run src/main.ts` processes, real
 * StdioLink pipe, real keystrokes through tmux. S types; A converges.
 *
 * A runs headless (--serve-stdio, spawned by S's shadow-connect), so we read
 * its buffer via the SIGUSR1 → /tmp/jemacs-dump-<pid> hook in main.ts.
 */
import { describe, expect, test } from "bun:test"
import { execSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const SKIP = !!process.env.JEMACS_SKIP_TUI || !!process.env.CI
const DRIVE = resolve(import.meta.dir, "../../scripts/tui-drive.sh")
const EMPTY_CONFIG = resolve(import.meta.dir, "../fixtures/empty-config.ts")

function drive(session: string, args: string[]): string {
  const r = spawnSync(DRIVE, args, { env: { ...process.env, JEMACS_TMUX_SESSION: session }, encoding: "utf8" })
  if (r.status !== 0 && args[0] !== "stop") {
    throw new Error(`tui-drive ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`)
  }
  return r.stdout
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

/** Find the --serve-stdio authority spawned by S. Keyed on the unique tmpdir
 *  name so concurrent test runs don't collide. */
function findAuthorityPid(marker: string): number {
  const out = execSync(`pgrep -f 'serve-stdio.*${marker}' || true`, { encoding: "utf8" }).trim()
  const pid = out.split("\n").map(Number).find(n => n > 0)
  if (!pid) throw new Error(`no --serve-stdio process matching ${marker}`)
  return pid
}

async function dumpBuffer(pid: number): Promise<string> {
  const path = `/tmp/jemacs-dump-${pid}`
  rmSync(path, { force: true })
  process.kill(pid, "SIGUSR1")
  for (let i = 0; i < 50; i++) {
    if (existsSync(path)) return readFileSync(path, "utf8")
    await sleep(20)
  }
  throw new Error(`SIGUSR1 dump never appeared at ${path}`)
}

describe.skipIf(SKIP)("shadow integration (tmux, real processes)", () => {
  test("S types over StdioLink → A's buffer converges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jemacs-shadow-int-"))
    const marker = dir.split("/").pop()!
    const file = join(dir, "doc.txt")
    writeFileSync(file, "")
    const session = `jt-shadow-${process.pid}`
    let aPid: number | undefined

    try {
      // S: normal jemacs UI in tmux.
      drive(session, ["start"])

      // M-x shadow-connect → spawns A as a child with FILE open.
      const target = `stdio:bun run src/main.ts --serve-stdio --config ${EMPTY_CONFIG} ${file}`
      drive(session, ["keys", "M-x", "shadow-connect", "Enter"])
      drive(session, ["keys", target, "Enter"])
      drive(session, ["wait", "\\[shadow\\] connected", "15"])

      // "[shadow] connected" fires as soon as the subprocess is spawned —
      // before A has booted and announced its buffers. C-x b's collection is
      // snapshotted at prompt time, so poll: open it, look for the file in the
      // candidate list, C-g and retry until it's there.
      let found = false
      for (let i = 0; i < 30 && !found; i++) {
        drive(session, ["keys", "C-x", "b"])
        await sleep(100)
        // The "[shadow] connected ..." echo also contains the path, and stale
        // screen bytes can trail other candidate rows; match the fido candidate
        // row for the announced buffer specifically: prefix + absolute path.
        found = /^(?: {2}|► )\/.*doc\.txt/m.test(drive(session, ["cap"]))
        if (!found) { drive(session, ["keys", "C-g"]); await sleep(200) }
      }
      expect(found).toBe(true)
      drive(session, ["keys", "doc.txt", "Enter"])
      drive(session, ["wait", "Switched to .*doc\\.txt", "5"])

      // Type into S. S applies optimistically and ships the splice.
      drive(session, ["keys", "hello from shadow"])
      drive(session, ["wait", "hello from shadow", "5"])

      // Convergence on S's side: pending drained → modeline shows [✓].
      drive(session, ["wait", "\\[✓\\]", "5"])

      // Convergence on A's side: dump its currentBuffer and compare.
      aPid = findAuthorityPid(marker)
      let aText = ""
      for (let i = 0; i < 20; i++) {
        aText = await dumpBuffer(aPid)
        if (aText === "hello from shadow") break
        await sleep(100)
      }
      expect(aText).toBe("hello from shadow")

      // And S's rendered text agrees.
      const screen = drive(session, ["cap"])
      expect(screen).toContain("hello from shadow")
    } finally {
      drive(session, ["stop"])
      // A is a grandchild of the tmux pane; killing the session doesn't always
      // reap it. pkill by the unique tmpdir marker so we don't hit other runs.
      try { execSync(`pkill -9 -f 'serve-stdio.*${marker}' 2>/dev/null`) } catch { /* none */ }
      if (aPid) rmSync(`/tmp/jemacs-dump-${aPid}`, { force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  }, 45_000)
})
