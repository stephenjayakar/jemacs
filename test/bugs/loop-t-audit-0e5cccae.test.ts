import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

// Regression: Electron entrypoint must load the builtin plugin set, same as the
// OpenTUI entrypoint. Source-level check because `electron` can't be imported
// under bun test (matches the pattern in test/electron-preload.test.ts).
test("electron entrypoint calls installBuiltinPlugins", async () => {
  const src = await readFile(join(import.meta.dirname, "../../src/main-electron.ts"), "utf8")
  expect(src).toMatch(/import\s*\{[^}]*installBuiltinPlugins[^}]*\}\s*from\s*["'][^"']*plugins\/builtin["']/)
  expect(src).toMatch(/await\s+installBuiltinPlugins\(editor\)/)
})
