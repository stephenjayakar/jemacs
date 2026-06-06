import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { keyToken, type KeyEventLike } from "../../src/kernel/keymap"

const LOG = join(homedir(), ".jemacs", "cmdlog.tsv")

function row(editor: Editor, command: string, key: KeyEventLike | null): string {
  const buf = editor.currentBuffer
  const tok = key ? keyToken(key) : ""
  // ts \t command \t mode \t buffer \t key \t rawDump  — rawDump only for unbound
  const raw = command.startsWith("unbound:") && key ? JSON.stringify(key) : ""
  return `${Date.now()}\t${command}\t${buf.mode}\t${buf.name}\t${tok}\t${raw}\n`
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  void mkdir(dirname(LOG), { recursive: true }).catch(() => {})
  let pending: string[] = []
  let flush: ReturnType<typeof setTimeout> | null = null
  const log = (cmd: string) => {
    pending.push(row(editor, cmd, editor.lastKeyEvent))
    if (flush) return
    flush = setTimeout(() => {
      const batch = pending.join(""); pending = []; flush = null
      void appendFile(LOG, batch).catch(() => {})
    }, 250)
  }

  editor.events.on("changed", ({ reason }) => {
    if (!reason.startsWith("command:")) return
    const cmd = reason.slice(8)
    if (cmd === "self-insert-command") return
    log(cmd)
  })
  editor.events.on("message", ({ text }) => {
    if (!text.startsWith("Unbound key:")) return
    log(`unbound:${text.slice(12).trim()}`)
  })

  editor.command("dogfood-report", async ({ editor }) => {
    let text: string
    try { text = await readFile(LOG, "utf8") } catch { editor.message("No cmdlog yet"); return }
    const rows = text.trim().split("\n").map(l => l.split("\t"))
    const tally = (pred: (cmd: string) => boolean) => {
      const m = new Map<string, number>()
      for (const r of rows) if (r[1] && pred(r[1])) m.set(r[1], (m.get(r[1]) ?? 0) + 1)
      return [...m.entries()].sort((a, b) => b[1] - a[1])
    }
    const fmt = (xs: Array<[string, number]>) => xs.map(([k, n]) => `  ${String(n).padStart(5)}  ${k}`).join("\n")
    editor.scratch("*dogfood*",
      `# ${rows.length} events from ${LOG}\n\n` +
      `## Unbound keys (fix these)\n${fmt(tally(c => c.startsWith("unbound:")).slice(0, 40)) || "  (none)"}\n\n` +
      `## Top commands\n${fmt(tally(c => !c.startsWith("unbound:")).slice(0, 40))}\n\n` +
      `## Raw event dumps for unbound (last 20)\n` +
      rows.filter(r => r[1]?.startsWith("unbound:") && r[5]).slice(-20).map(r => `  ${r[4]}\t${r[5]}`).join("\n"))
  }, "Summarize ~/.jemacs/cmdlog.tsv: top unbound keys (with raw event dumps) and top commands.")

  editor.command("dogfood-clear", async ({ editor }) => {
    await writeFile(LOG, ""); editor.message("cmdlog cleared")
  })
}
