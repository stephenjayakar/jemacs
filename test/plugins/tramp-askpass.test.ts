import { test, expect } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { createAskpassBroker, type AskpassInteraction } from "../../plugins/tramp/askpass"
import { buildSshArgv, buildSshEnv, parseTrampFileName, SshRemoteTransport } from "../../plugins/tramp"

test("askpass broker answers request files atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-askpass-test-"))
  const calls: Array<{ prompt: string; mask?: boolean }> = []
  const broker = await createAskpassBroker({
    async ask(prompt, options) {
      calls.push({ prompt, mask: options?.mask })
      return "swordfish"
    },
  }, dir)

  try {
    await writeFile(join(dir, "req.1"), "Password: ", "utf8")
    const response = await waitForFile(join(dir, "resp.1"))
    expect(response).toBe("swordfish")
    expect(calls).toEqual([{ prompt: "Password: ", mask: true }])
  } finally {
    await broker.close()
  }
})

test("ssh argv/env uses askpass and does not force BatchMode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-askpass-env-"))
  const broker = await createAskpassBroker({ ask: async () => "ok" }, dir)
  try {
    const file = parseTrampFileName("/ssh:alice@example.com#2222:/home/alice/app.ts")!
    const argv = buildSshArgv(file, "printf ok", "/home/alice/.ssh")
    expect(argv).not.toContain("BatchMode=yes")
    expect(argv).toContain("ConnectTimeout=10")
    expect(argv).toContain("ControlMaster=auto")
    const env = buildSshEnv(broker, {})
    expect(env.SSH_ASKPASS).toBe(broker.script)
    expect(env.SSH_ASKPASS_REQUIRE).toBe("force")
    expect(env.JEMACS_ASKPASS_DIR).toBe(broker.dir)
    expect(env.DISPLAY).toBe(":0")
  } finally {
    await broker.close()
  }
})

test("ssh transport can satisfy password auth through askpass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-fake-ssh-"))
  const bin = join(dir, "bin")
  await mkdir(bin)
  const ssh = join(bin, "ssh")
  await writeFile(ssh, `#!/bin/sh
set -eu
answer="$("$SSH_ASKPASS" "alice@box's password: ")"
if [ "$answer" != "secret" ]; then
  printf 'bad password\\n' >&2
  exit 255
fi
printf 'remote body\\n'
`, "utf8")
  await chmod(ssh, 0o700)

  const oldPath = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`
  const transport = new SshRemoteTransport(scriptedInteraction("secret"))
  try {
    const text = await transport.readFile(parseTrampFileName("/ssh:alice@box:/tmp/file.txt")!)
    expect(text).toBe("remote body\n")
  } finally {
    await transport.close()
    if (oldPath == null) delete process.env.PATH
    else process.env.PATH = oldPath
    await rm(dir, { recursive: true, force: true })
  }
})

function scriptedInteraction(answer: string): AskpassInteraction {
  return { ask: async () => answer }
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 2_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8")
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${path}`)
}
