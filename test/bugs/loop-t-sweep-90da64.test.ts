import { expect, test } from "bun:test"
import { mkdtemp, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "../plugins/helper"
import { install as installAutoSave } from "../../plugins/auto-save"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"

// t-sweep-90da64: openFile/doAutoSave/recoverThisFile messages interpolate raw
// buffer.name, which is ambiguous when two buffers share a basename. They live
// inside Editor so this.bufferDisplayName(buffer) — the uniquified name — is
// available and should be used instead.
test("auto-save messages use uniquified bufferDisplayName, not raw buffer.name", async () => {
  const root = await mkdtemp(join(tmpdir(), "jemacs-dispname-"))
  let ctx: PluginContext | undefined
  try {
    const a = join(root, "a"), b = join(root, "b")
    await Bun.write(join(a, "same.txt"), "alpha")
    await Bun.write(join(b, "same.txt"), "bravo")
    // Backdate b/same.txt so the autosave file we write next is strictly newer.
    const past = Date.now() / 1000 - 60
    await utimes(join(b, "same.txt"), past, past)
    await Bun.write(join(b, "#same.txt#"), "bravo-autosaved")

    const editor = makeEditor()
    installAutoSave(editor, ctx = createPluginContext(editor))
    const messages: string[] = []
    editor.events.on("message", ({ text }) => { messages.push(text) })

    await editor.openFile(join(a, "same.txt"))
    const bufB = await editor.openFile(join(b, "same.txt"))

    // Two buffers named "same.txt" → display names are uniquified with <dir>.
    const display = editor.bufferDisplayName(bufB)
    expect(display).not.toBe("same.txt")
    expect(display).toContain("same.txt<")

    // openFile :429 — auto-save-data warning must use the disambiguated name.
    const warn = messages.find(m => m.includes("has auto save data"))
    expect(warn).toBeDefined()
    expect(warn).toContain(display)

    // recoverThisFile :866 — success message must use the disambiguated name.
    editor.prompt = async () => "y"
    messages.length = 0
    await editor.recoverThisFile(bufB)
    const recovered = messages.find(m => m.startsWith("Recovered "))
    expect(recovered).toBeDefined()
    expect(recovered).toContain(display)
  } finally {
    ctx?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
