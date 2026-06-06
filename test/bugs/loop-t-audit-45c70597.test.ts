import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, normalize, relative, sep } from "node:path"

// t-audit-45c70597 — layering: kernel/ is the "C core" (DESIGN.md) and must not
// import upward from modes|display|themes|lsp|lisp|plugins. Static import-graph
// assertion that locks the split in once tasks 12–21/39 move the offending
// callers out of editor.ts/isearch.ts. Flip to `test(...)` when violations==[].
test.failing("kernel/ does not import modes|display|themes|lsp|lisp|plugins", () => {
  const repo = join(import.meta.dir, "../..")
  const kernelDir = join(repo, "src/kernel")
  const forbidden = ["src/modes", "src/display", "src/themes", "src/lsp", "lisp", "plugins"]
  const importRe = /(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g

  const violations: string[] = []
  for (const f of readdirSync(kernelDir).filter(f => f.endsWith(".ts"))) {
    const src = readFileSync(join(kernelDir, f), "utf8")
    for (const m of src.matchAll(importRe)) {
      const spec = m[1] ?? m[2]
      if (!spec || !spec.startsWith(".")) continue
      const target = relative(repo, normalize(join(kernelDir, spec)))
      const hit = forbidden.find(p => target === p || target.startsWith(p + sep))
      if (hit) violations.push(`src/kernel/${f} -> ${spec} (${hit})`)
    }
  }
  expect(violations).toEqual([])
})
