import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { installBuiltinJdapAdapters } from "../src/dap/adapters"
import { jdapAdapter } from "../src/dap/api"
import { DapSession } from "../src/dap/session"
import type { JdapContext, JdapLaunchConfiguration } from "../src/dap/types"

const SKIP = process.env.JDAP_INTEGRATION !== "1"
const root = join(import.meta.dir, "fixtures")
const context: JdapContext = {
  projectRoot: root,
  workspaceFolders: { fixtures: root },
  cwd: root,
  env: name => process.env[name],
  configValues: {},
}

async function runAdapter(config: JdapLaunchConfiguration): Promise<DapSession> {
  const adapter = jdapAdapter(config.type)
  if (!adapter) throw new Error(`No adapter for ${config.type}`)
  const descriptor = await adapter.resolve(config, context)
  const session = new DapSession(config.name, config, descriptor, {
    breakpoints: () => [],
    changed: () => {},
  })
  await session.start()
  return session
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await Bun.sleep(20)
  }
}

describe.skipIf(SKIP)("real jdap adapters (JDAP_INTEGRATION=1)", () => {
  const dispose = installBuiltinJdapAdapters()

  test("debugpy launches, steps, evaluates, and completes a Python program", async () => {
    const session = await runAdapter({
      name: "real debugpy",
      type: "debugpy",
      request: "launch",
      program: join(root, "jdap-sample.py"),
      stopOnEntry: true,
      console: "internalConsole",
    })
    await waitFor(() => session.state === "stopped", "debugpy to stop on entry")
    expect(session.selectedFrame?.line).toBe(1)

    await session.next()
    await waitFor(() => session.state === "stopped" && session.selectedFrame?.line === 2, "debugpy to step to line 2")
    expect((await session.evaluate("answer")).result).toBe("42")

    await session.continue()
    await waitFor(() => session.state === "terminated", "the Python program to terminate")
    expect(session.output.some(output => output.text.includes("42"))).toBe(true)
  })

  test("js-debug launches a Node program", async () => {
    const session = await runAdapter({
      name: "real js-debug",
      type: "pwa-node",
      request: "launch",
      program: join(root, "jdap-sample.js"),
      stopOnEntry: true,
      console: "internalConsole",
    })
    expect(["running", "stopped", "terminated"]).toContain(session.state)
    await session.disconnect()
    dispose()
  })
})
