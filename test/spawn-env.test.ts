import { afterEach, expect, test } from "bun:test"
import { spawnProcess } from "../src/platform/runtime"

// Emacs subprocesses see `process-environment` as it is when they start. Bun
// snapshots the environment at startup, so a variable set later (say, a
// plugin default for LANG) used to be missing in the child.
afterEach(() => { delete process.env.JEMACS_SPAWN_ENV_PROBE })

test("a process.env write made after startup reaches spawned processes", async () => {
  process.env.JEMACS_SPAWN_ENV_PROBE = "utf-8"
  const proc = spawnProcess({ cmd: ["sh", "-c", "printf %s \"$JEMACS_SPAWN_ENV_PROBE\""], stdout: "pipe" })
  expect(await new Response(proc.stdout!).text()).toBe("utf-8")
  expect(await proc.exited).toBe(0)
})
