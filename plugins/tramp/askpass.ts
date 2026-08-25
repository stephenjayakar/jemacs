import { watch as fsWatch, type FSWatcher } from "node:fs"
import { chmod, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type AskpassInteraction = {
  ask(prompt: string, options?: { mask?: boolean }): Promise<string | null>
}

export type AskpassBroker = {
  dir: string
  script: string
  close(): Promise<void>
}

const ASKPASS_SCRIPT = `#!/bin/sh
set -eu
dir="\${JEMACS_ASKPASS_DIR:?}"
stamp="$(date +%s 2>/dev/null || printf 0)"
n="$$.$stamp.\${RANDOM:-0}"
req="$dir/req.$n"
resp="$dir/resp.$n"
printf '%s' "$1" > "$req"
while [ ! -f "$resp" ]; do
  sleep 0.1
done
cat "$resp"
rm -f "$req" "$resp"
`

export async function createAskpassBroker(interaction: AskpassInteraction, dir?: string): Promise<AskpassBroker> {
  const askpassDir = dir ?? await mkdtemp(join(tmpdir(), "jemacs-askpass-"))
  const script = join(askpassDir, "askpass.sh")
  await writeFile(script, ASKPASS_SCRIPT, "utf8")
  await chmod(script, 0o700)

  const answered = new Set<string>()
  let closed = false
  let watcher: FSWatcher | null = null
  let polling: ReturnType<typeof setInterval> | null = null

  const scan = async () => {
    if (closed) return
    let entries: string[]
    try {
      entries = await readdir(askpassDir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.startsWith("req.") || answered.has(entry)) continue
      answered.add(entry)
      void answerRequest(askpassDir, entry, interaction)
    }
  }

  try {
    watcher = fsWatch(askpassDir, { persistent: false }, () => { void scan() })
  } catch {
    polling = setInterval(() => { void scan() }, 100)
    polling.unref?.()
  }
  if (!polling) {
    polling = setInterval(() => { void scan() }, 500)
    polling.unref?.()
  }
  void scan()

  return {
    dir: askpassDir,
    script,
    async close() {
      closed = true
      watcher?.close()
      if (polling) clearInterval(polling)
      await rm(askpassDir, { recursive: true, force: true })
    },
  }
}

async function answerRequest(dir: string, reqEntry: string, interaction: AskpassInteraction): Promise<void> {
  const req = join(dir, reqEntry)
  const suffix = reqEntry.slice("req.".length)
  const resp = join(dir, `resp.${suffix}`)
  const tmp = join(dir, `.resp.${suffix}.${process.pid}.tmp`)
  try {
    const prompt = await readFile(req, "utf8")
    const answer = await interaction.ask(prompt, { mask: !isHostKeyPrompt(prompt) })
    await writeFile(tmp, answer ?? "", "utf8")
    await rename(tmp, resp)
  } catch {
    await writeFile(tmp, "", "utf8").catch(() => {})
    await rename(tmp, resp).catch(() => {})
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

function isHostKeyPrompt(prompt: string): boolean {
  return /\(yes\/no/i.test(prompt) || /yes\/no\/\[fingerprint\]/i.test(prompt)
}
