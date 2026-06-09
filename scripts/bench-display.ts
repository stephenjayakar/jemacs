// Benchmark buildDisplayModel — guards against LogicalModel-split perf regression.
// Run: bun run scripts/bench-display.ts [iterations]
import { readFileSync } from "node:fs"
import { Editor } from "../src/kernel/editor"
import { BufferModel } from "../src/kernel/buffer"
import { installDefaultConfig } from "../src/config"
import { buildDisplayModel } from "../src/display/build-display-model"

const N = Number(process.argv[2] ?? 2000)
const text = readFileSync("src/kernel/editor.ts", "utf8")  // ~1200 lines, real spans

const editor = new Editor()
installDefaultConfig(editor)
const buf = new BufferModel({ name: "bench.ts", text, mode: "typescript" })
editor.addBuffer(buf)
editor.currentBufferId = buf.id
buf.point = Math.floor(text.length / 2)
editor.lastViewport = { rows: 50, cols: 120 }

// Warm
for (let i = 0; i < 50; i++) buildDisplayModel(editor, { viewport: { rows: 50, cols: 120 } })

const t0 = performance.now()
for (let i = 0; i < N; i++) {
  buf.point = (buf.point + 17) % text.length
  buildDisplayModel(editor, { viewport: { rows: 50, cols: 120 } })
}
const ms = performance.now() - t0
console.log(JSON.stringify({ iterations: N, totalMs: Math.round(ms), msPerOp: +(ms / N).toFixed(3), lines: text.split("\n").length }))
