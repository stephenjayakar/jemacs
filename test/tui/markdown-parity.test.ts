import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emacsProbe } from "../harness/emacs"
import { normalizeMarkdownBuffer } from "../harness/parity"
import { tuiProbe } from "../harness/tui"

const FIXTURE = resolve(import.meta.dir, "../../examples/docs/guide.md")
const TIMEOUT = 20000
const SKIP = !!process.env.JEMACS_SKIP_TUI || !!process.env.CI || !process.env.JEMACS_PARITY_EMACS

function scratchMd(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), name))
  const path = join(dir, "doc.md")
  writeFileSync(path, text, "utf8")
  return path
}

async function driveBoth(file: string, keys: string[], save = true): Promise<{ jemacs: string; emacs: string }> {
  const jpath = scratchMd("jp-", readFileSync(file, "utf8"))
  const epath = scratchMd("ep-", readFileSync(file, "utf8"))
  const allKeys = save ? [...keys, "C-x", "C-s"] : keys
  await tuiProbe({ file: jpath, keys: allKeys })
  await emacsProbe({ file: epath, keys: allKeys })
  return { jemacs: readFileSync(jpath, "utf8"), emacs: readFileSync(epath, "utf8") }
}

describe.skipIf(SKIP)("markdown parity: jemacs vs Emacs (tmux)", () => {
  test("opens .md as markdown / Markdown mode", async () => {
    const j = await tuiProbe({ file: FIXTURE, keys: [] })
    const e = await emacsProbe({ file: FIXTURE, keys: [] })
    expect(j.screen.match(/markdown|gfm/)?.[0]).toBeTruthy()
    expect(e.modeline).toMatch(/Markdown/)
  }, TIMEOUT)

  test("RET (jemacs-clear-whitespace-and-newline-and-indent) trims trailing space on previous line", async () => {
    const src = scratchMd("ret-src-", "line with spaces   ")
    const { jemacs, emacs } = await driveBoth(src, ["End", "Enter"])
    expect(normalizeMarkdownBuffer(jemacs).split("\n")[0]).toBe("line with spaces")
    expect(normalizeMarkdownBuffer(emacs).split("\n")[0]).toBe("line with spaces")
  }, TIMEOUT)

  test("Stephen config RET continues a checklist with a new unchecked item", async () => {
    const src = scratchMd("ret-list-src-", "- [ ] first\n- [ ] second\n")
    const { jemacs, emacs } = await driveBoth(src, ["C-n", "C-e", "Enter"])
    expect(normalizeMarkdownBuffer(jemacs)).toBe("- [ ] first\n- [ ] second\n- [ ]")
    expect(normalizeMarkdownBuffer(jemacs)).toBe(normalizeMarkdownBuffer(emacs))
  }, TIMEOUT)

  test("TAB on a flat checklist matches Emacs' first two-column step", async () => {
    const src = scratchMd("tab-list-src-", "- [ ] first\n- [ ] second\n")
    const { jemacs, emacs } = await driveBoth(src, ["C-n", "C-a", "Tab"])
    expect(normalizeMarkdownBuffer(jemacs)).toBe("- [ ] first\n  - [ ] second")
    expect(normalizeMarkdownBuffer(jemacs)).toBe(normalizeMarkdownBuffer(emacs))
  }, TIMEOUT)

  test("repeated TAB cycles a flat checklist through the same indentation stops", async () => {
    const src = scratchMd("tab-cycle-src-", "- [ ] first\n- [ ] second\n")
    const { jemacs, emacs } = await driveBoth(src, ["C-n", "C-a", "Tab", "Tab", "Tab", "Tab"])
    expect(normalizeMarkdownBuffer(jemacs)).toBe("- [ ] first\n- [ ] second")
    expect(normalizeMarkdownBuffer(jemacs)).toBe(normalizeMarkdownBuffer(emacs))
  }, TIMEOUT)

  test("TAB on a nested checklist matches Emacs' list-aware indentation", async () => {
    const src = scratchMd("tab-nested-src-", "- [ ] parent\n    - [ ] child\n    - [ ] sibling\n")
    const { jemacs, emacs } = await driveBoth(src, ["C-n", "C-n", "C-a", "Tab"])
    expect(normalizeMarkdownBuffer(jemacs)).toBe(normalizeMarkdownBuffer(emacs))
  }, TIMEOUT)

  test("TAB on ATX heading reports FOLDED without mutating heading text", async () => {
    const src = scratchMd("tab-src-", "# Guide\nbody\n")
    const jpath = scratchMd("jt-", "# Guide\nbody\n")
    const epath = scratchMd("et-", "# Guide\nbody\n")
    const j = await tuiProbe({ file: jpath, keys: ["Tab"] })
    const e = await emacsProbe({ file: epath, keys: ["Tab"] })
    expect(j.echo).toMatch(/FOLDED/i)
    expect(e.echo).toMatch(/FOLDED/i)
    expect(readFileSync(jpath, "utf8")).toMatch(/^# Guide/)
    expect(readFileSync(epath, "utf8")).toMatch(/^# Guide/)
  }, TIMEOUT)

  test("C-c C-l starts link insertion by prompting for URL/reference", async () => {
    const jpath = scratchMd("jl-", "text\n")
    const epath = scratchMd("el-", "text\n")
    const j = await tuiProbe({ file: jpath, keys: ["C-c", "C-l"], waitFor: "URL or" })
    const e = await emacsProbe({ file: epath, keys: ["C-c", "C-l"], waitFor: "URL or" })
    expect(j.screen).toMatch(/URL or \[reference\]/)
    expect(e.screen).toMatch(/URL or \[reference\]/)
    expect(readFileSync(jpath, "utf8")).toBe("text\n")
  }, TIMEOUT)

  test("C-s [ starts a literal bracket search", async () => {
    const src = scratchMd("search-src-", "before [bracket] after\n")
    const j = await tuiProbe({ file: src, keys: ["C-s", "["] })
    const e = await emacsProbe({ file: src, keys: ["C-s", "["] })
    expect(j.screen).toContain("I-search: [")
    expect(e.screen).toContain("I-search: [")
  }, TIMEOUT)

  test("double RET on empty list item yields blank line (guide.md list)", async () => {
    copyFileSync(FIXTURE, scratchMd("dbl-", readFileSync(FIXTURE, "utf8")))
    const src = scratchMd("list-src-", "- item\n")
    const jpath = scratchMd("jl-", "- item\n")
    const epath = scratchMd("el-", "- item\n")
    // Point at end of "- item", two RETs
    await tuiProbe({ file: jpath, keys: ["End", "Enter", "Enter", "C-x", "C-s"] })
    await emacsProbe({ file: epath, keys: ["End", "Enter", "Enter", "C-x", "C-s"] })
    const j = normalizeMarkdownBuffer(readFileSync(jpath, "utf8"))
    const e = normalizeMarkdownBuffer(readFileSync(epath, "utf8"))
    expect(j).toBe(e)
  }, TIMEOUT)
})
