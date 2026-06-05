import { describe, expect, test } from "bun:test"
import { tuiProbe } from "../harness/tui"

// Layer-3 regression smoke: real OpenTUI in a tmux pty. Catches the key-encoding
// and render bugs that layer-1 (hand-built KeyEventLike) and layer-2 (DisplayModel)
// can't see — shifted-punctuation meta chords, C-SPC vs C-@, fido overlay paint.
// Each probe is ~500ms; keep this file small.

const FIXTURE = "examples/docs/guide.md" // 16 lines, stable
const TIMEOUT = 8000

// tuiProbe's modeline/echo split is only stable when an echo line is present;
// match the modeline out of `screen` instead.
const MODELINE = /^ \S+.* {2}line \d+, col \d+.*$/m

describe("tui smoke", () => {
  test("M-> end-of-buffer reaches last line", async () => {
    const { screen } = await tuiProbe({ file: FIXTURE, keys: ["M->"] })
    expect(screen).toMatch(MODELINE)
    expect(screen.match(MODELINE)![0]).toMatch(/guide\.md\s+line 16, col 1/)
  }, TIMEOUT)

  test("M-< beginning-of-buffer after M-> returns to line 1", async () => {
    const { screen } = await tuiProbe({ file: FIXTURE, keys: ["M->", "M-<"] })
    const ml = screen.match(MODELINE)![0]
    expect(ml).toMatch(/line 1, col 1/)
    // Cursor block paints over the `#` at col 1.
    expect(screen).toMatch(/^ 1 +█ Guide$/m)
  }, TIMEOUT)

  test("C-SPC sets mark and region survives motion; C-g clears it", async () => {
    const active = await tuiProbe({ file: FIXTURE, keys: ["C-Space", "C-n", "C-n"] })
    expect(active.echo).toContain("Mark set")
    expect(active.modeline).toMatch(/line 3, col 1\s+\(\d+ chars\)/)

    const cleared = await tuiProbe({ file: FIXTURE, keys: ["C-Space", "C-n", "C-n", "C-g"] })
    expect(cleared.screen.match(MODELINE)![0]).not.toMatch(/chars\)/)
  }, TIMEOUT)

  test("C-e leaves the cursor block visible at end-of-line", async () => {
    const { screen } = await tuiProbe({ file: FIXTURE, keys: ["C-n", "C-n", "C-e"] })
    expect(screen.match(MODELINE)![0]).toMatch(/line 3, col 11/)
    // Cursor glyph rendered immediately after the line text, not lost off-screen.
    expect(screen).toMatch(/## Install█/)
  }, TIMEOUT)

  test("C-x C-f opens find-file with fido vertical candidates", async () => {
    const { screen } = await tuiProbe({
      file: FIXTURE,
      keys: ["C-x", "C-f"],
      waitFor: "Find file:",
    })
    expect(screen).toMatch(/Find file: .*docs\//)
    // Candidate list rendered (either fido ► or vertico — frontend-agnostic).
    expect(screen).toContain("guide.md")
  }, TIMEOUT)

  test("C-x C-f flex-narrows on typed input", async () => {
    const { screen } = await tuiProbe({
      file: FIXTURE,
      keys: ["C-x", "C-f", "gui"],
      waitFor: "Find file:",
    })
    expect(screen).toMatch(/Find file: .*docs\/gui/)
    expect(screen).toContain("guide.md")
    expect(screen).not.toContain("[No match]")
  }, TIMEOUT)

  test("M-x term opens a shell in a *term* buffer", async () => {
    const { modeline, echo } = await tuiProbe({
      keys: ["M-x", "term", "Enter"],
      waitFor: "\\*term\\*",
    })
    expect(modeline).toMatch(/^\s*term\b/)
    expect(modeline).toContain("*term*<")
    expect(echo).toMatch(/^\s*term: .* \(pid \d+\)/)
  }, TIMEOUT)
})
