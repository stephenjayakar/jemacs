import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "../plugins/helper"
import { createPluginContext } from "../../src/runtime/plugin-context"
import { defcustom, setCustom } from "../../src/runtime/custom"
import { install } from "../../plugins/persist"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jemacs-persist-bug-"))
  // defcustom is idempotent; ensure the var exists before setCustom regardless of test order.
  defcustom("savehist-autosave-interval", "number", 300, "")
  setCustom("savehist-autosave-interval", 0.02)
})

afterEach(async () => {
  setCustom("savehist-autosave-interval", 300)
  await rm(dir, { recursive: true, force: true })
})

// Module-level `let autosaveTimer` meant the second install() cancelled the
// first editor's timer, and disposing the first editor's ctx cancelled the
// second's. Per-editor state must live in a WeakMap (t-audit-bfbba508).
test("persist: disposing one editor's ctx leaves other editors' autosave running", async () => {
  const a = makeEditor()
  const ctxA = createPluginContext(a)
  await install(a, ctxA)

  const b = makeEditor()
  const ctxB = createPluginContext(b)
  await install(b, ctxB)

  setCustom("savehist-file", join(dir, "history.json"))
  b.minibufferHistory.set("file", ["/from-b"])

  ctxA.dispose()

  await new Promise(r => setTimeout(r, 60))

  const raw = await readFile(join(dir, "history.json"), "utf8").catch(() => null)
  expect(raw).not.toBeNull()
  expect(JSON.parse(raw!).file).toEqual(["/from-b"])

  ctxB.dispose()
})
