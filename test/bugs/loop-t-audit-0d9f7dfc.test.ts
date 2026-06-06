import { expect, test } from "bun:test"
import { writeFile, mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { script } from "../harness"
import { Evaluator } from "../../src/runtime/evaluator"
import { clearAdvice } from "../../src/runtime/advice"

// t-audit-0d9f7dfc — hot-reload duplicates advice on every reload.
// ctx.advice() never registered a disposer (no removeAdvice export), so
// dispose() left old advice in adviceByCommand and each reload stacked
// another copy. Mirrors the hooks-reload test in hot-reload.test.ts.
test("reload does not accumulate advice (PluginContext dispose)", async () => {
  clearAdvice("hot-adv-cmd")
  const dir = await mkdtemp(join(tmpdir(), "jemacs-hot-adv-"))
  const file = join(dir, "p.ts")
  await writeFile(
    file,
    `export function install(e, ctx) {
       e.command("hot-adv-cmd", () => {})
       ctx.advice("hot-adv-cmd", { before: () => e.message("adv") })
     }`,
  )
  const editor = await script({ plugins: false }).done()
  const ev = new Evaluator(editor)
  let n = 0
  editor.events.on("message", () => { n++ })
  await ev.loadPlugin(file)
  await ev.loadPlugin(file) // reload: old ctx.dispose() must drop the prior advice
  await editor.run("hot-adv-cmd")
  expect(n).toBe(1)
})
