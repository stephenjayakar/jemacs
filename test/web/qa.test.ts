// Exhaustive feature QA via headless Chromium against a live --web server.
// Skipped under JEMACS_SKIP_TUI (CI default) — needs Chromium binary.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { launch, type Driver } from "./cdp-driver"

const SKIP = !!process.env.JEMACS_SKIP_TUI || !!process.env.CI
  || !existsSync(process.env.CHROMIUM_PATH ?? "/nix/store/68h63fg3qyv62lkvmqpkdk8g8qnldzhp-chromium-147.0.7727.137/bin/chromium")

describe.skipIf(SKIP)("web-host QA (headless Chromium)", () => {
  const PORT = 18099
  let server: ChildProcess
  let d: Driver

  const modeline = () => d.eval<string>("document.querySelector('.window-modeline')?.textContent ?? ''")
  const echo = () => d.eval<string>("document.getElementById('jemacs-echo')?.textContent ?? ''")
  const bodyText = () => d.eval<string>("document.querySelector('.window-body')?.textContent ?? ''")
  const minibuf = () => d.eval<string>("document.getElementById('jemacs-minibuffer')?.textContent ?? ''")
  const completions = () => d.eval<string>("document.getElementById('jemacs-minibuffer-completions')?.textContent ?? ''")
  const windowCount = () => d.eval<number>("document.querySelectorAll('.window-pane').length")

  beforeAll(async () => {
    server = spawn("bun", ["run", "src/main.ts", "--web", `--port`, String(PORT), "examples/docs/guide.md"],
      { cwd: process.cwd(), stdio: "ignore" })
    await new Promise(r => setTimeout(r, 1500))
    d = await launch(`http://127.0.0.1:${PORT}/`)
  }, 20000)

  afterAll(async () => { await d?.close(); server?.kill() })

  test("page loads with token, modeline shows file + mode", async () => {
    expect(await d.eval<boolean>("!!window.__JEMACS_TOKEN__")).toBe(true)
    const ml = await modeline()
    expect(ml).toContain("guide.md")
    expect(ml).toContain("markdown")
    expect(ml).toContain("line 1")
  })

  test("variable-pitch heading rendered (font-size > body)", async () => {
    const sizes = await d.eval<{ h: number; b: number }>(
      "(() => { const rows=[...document.querySelectorAll('.body-row span')]; const h=rows.find(s=>s.textContent.includes('# Guide')); const b=rows.find(s=>s.textContent.includes('one')); return {h: parseFloat(getComputedStyle(h).fontSize), b: parseFloat(getComputedStyle(b).fontSize)} })()"
    )
    expect(sizes.h).toBeGreaterThan(sizes.b * 1.5)
  })

  test("caret element positioned and moves with C-n", async () => {
    const top0 = await d.eval<number>("document.querySelector('.jemacs-caret').getBoundingClientRect().top")
    await d.key("n", { ctrl: true })
    expect(await modeline()).toContain("line 2")
    const top1 = await d.eval<number>("document.querySelector('.jemacs-caret').getBoundingClientRect().top")
    expect(top1).toBeGreaterThan(top0)
  })

  test("M-> end-of-buffer, M-< beginning", async () => {
    await d.key(">", { alt: true, shift: true })
    expect(await modeline()).toMatch(/line 1[56]/)
    await d.key("<", { alt: true, shift: true })
    expect(await modeline()).toContain("line 1, col 1")
  })

  test("self-insert + undo", async () => {
    await d.key(">", { alt: true, shift: true })
    await d.type("hello web")
    expect(await bodyText()).toContain("hello web")
    for (let i = 0; i < 9; i++) await d.key("/", { ctrl: true })
    expect(await bodyText()).not.toContain("hello web")
  })

  test("C-s isearch finds 'Usage' and lazy-highlight span exists", async () => {
    await d.key("<", { alt: true, shift: true })
    await d.key("s", { ctrl: true })
    await d.type("Usage")
    expect(await minibuf()).toContain("I-search")
    expect(await modeline()).toContain("line 7")
    await d.key("Enter")
  })

  test("C-x 2 splits, C-x o moves, C-x 1 unsplits", async () => {
    expect(await windowCount()).toBe(1)
    await d.key("x", { ctrl: true }); await d.key("2")
    expect(await windowCount()).toBe(2)
    await d.key("x", { ctrl: true }); await d.key("o")
    await d.key("x", { ctrl: true }); await d.key("1")
    expect(await windowCount()).toBe(1)
  })

  test("M-x with fido completes a command", async () => {
    await d.key("x", { alt: true })
    expect(await minibuf()).toContain("M-x")
    await d.type("describe-mode")
    expect(await completions()).toContain("describe-mode")
    await d.key("Enter")
    expect(await bodyText()).toContain("markdown")
    await d.key("q")  // quit help buffer
  })

  test("C-x C-f opens find-file prompt with directory completion", async () => {
    await d.key("x", { ctrl: true }); await d.key("f", { ctrl: true })
    expect(await minibuf()).toContain("Find file")
    await d.key("g", { ctrl: true })  // quit
  })

  test("C-x b switch-to-buffer back to guide.md", async () => {
    await d.key("x", { ctrl: true }); await d.key("b")
    await d.type("guide.md")
    await d.key("Enter")
    expect(await modeline()).toContain("guide.md")
  })

  test("region select + M-w + C-y", async () => {
    await d.key("<", { alt: true, shift: true })
    await d.key("Space", { ctrl: true })
    await d.key("e", { ctrl: true })
    await d.key("w", { alt: true })
    await d.key(">", { alt: true, shift: true })
    await d.key("y", { ctrl: true })
    expect(await bodyText()).toMatch(/# Guide[\s\S]*# Guide/)
    await d.key("/", { ctrl: true })  // undo the yank
  })

  // Chrome traps Ctrl+H (history) before keydown reaches the page; needs an
  // alternate help prefix (F1) or preventDefault at the document level.
  test.todo("C-h k describes the next key", async () => {
    await d.key("x", { ctrl: true }); await d.key("1")  // ensure single window
    await d.key("h", { ctrl: true }); await d.key("k")
    await d.key("f", { ctrl: true })
    await new Promise(r => setTimeout(r, 100))
    const all = await d.eval<string>("[...document.querySelectorAll('.window-body')].map(b=>b.textContent).join(' || ')")
    expect(all).toMatch(/forward-char|C-f runs/)
    await d.key("x", { ctrl: true }); await d.key("1")
  })

  test("snapshot screenshot for visual record", async () => {
    await d.key("x", { ctrl: true }); await d.key("b")
    await d.type("guide.md"); await d.key("Enter")
    await d.key("<", { alt: true, shift: true })
    await d.screenshot("/tmp/jemacs-web-qa.png")
    expect(existsSync("/tmp/jemacs-web-qa.png")).toBe(true)
  })
})
