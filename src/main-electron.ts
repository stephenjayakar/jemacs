import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { app } from "electron"
import { buildDisplayModel } from "./display/build-display-model"
import { findPaneInModel } from "./display/find-pane"
import { Editor } from "./kernel/editor"
import { listWindowLeaves } from "./kernel/window"
import { bindGuiKeybindings, installDefaultConfig, installDefaultHooks, installUserConfig, loadCustomFile } from "./config"
import { installBuiltinPlugins } from "../plugins/builtin"
import { loadStartupConfig, parseStartupArgs } from "./config/startup"
import { installDefaultModes } from "./modes/default-modes"
import { installLspMode } from "./lsp/install"
import { installXref } from "./xref/install"
import { runJemacsCore } from "./run-core"
import { ElectronHost } from "./ui/electron-host"

/** Headless-ish GUI smoke: opens a window briefly, exercises editor + IPC, then quits. */
async function runGuiSmokeTest(editor: Editor, host: ElectronHost): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 1500))

  const dir = await mkdtemp(join(tmpdir(), "jemacs-gui-smoke-"))
  const filePath = join(dir, "smoke-open.ts")
  await writeFile(filePath, "export const guiOpenWorks = true\n", "utf8")
  await editor.openFile(filePath)
  if (!editor.currentBuffer.text.includes("guiOpenWorks")) {
    throw new Error("openFile failed under Electron (platform I/O)")
  }

  const tsBuffer = editor.scratch("font-lock.ts", "const highlighted: number = 42\n", "typescript")
  const fontSpans = editor.fontLock(tsBuffer)
  if (!fontSpans.length) {
    throw new Error("font-lock returned no spans in Electron (tree-sitter native module?)")
  }

  editor.scratch("smoke", "before-split", "text")
  await editor.run("split-window-below")
  if (listWindowLeaves(editor.windowLayout).length < 2) {
    throw new Error("split-window-below did not create a second window")
  }

  await editor.handleKey({ name: "x", ctrl: true })
  await editor.handleKey({ name: "o", ctrl: true })
  editor.activeBuffer.insert("-verified")
  await editor.changed("gui-smoke-insert")

  const model = buildDisplayModel(editor, {
    lastMessage: "",
    viewport: host.getViewport(),
    hostLabel: "Jemacs GUI",
  })
  if (model.hostLabel !== "Jemacs GUI") throw new Error("unexpected host label")
  if (!findPaneInModel(model.windows, editor.selectedWindowId)) {
    throw new Error("display model missing selected pane")
  }
  if (!editor.activeBuffer.text.includes("verified")) {
    throw new Error("buffer insert did not apply")
  }

  await assertRendererPaints(editor, host)

  await rm(dir, { recursive: true })
  console.log("GUI smoke OK: open-file, split, other-window, insert, display model")
  host.destroy()
  app.quit()
}

/** Let the redisplay microtask run and the IPC frame reach the renderer. */
const settleFrame = () => new Promise(resolve => setTimeout(resolve, 400))

/**
 * Assert against the DOM Chromium actually built.
 *
 * Redisplay reaches the GUI only through `ElectronHost.syncFrames`, so a mistake there
 * leaves a blank window while every main-process assertion still passes. These checks
 * read the live renderer, which is the only way to catch that.
 */
async function assertRendererPaints(editor: Editor, host: ElectronHost): Promise<void> {
  const text = async (selector: string) =>
    await host.queryRenderer<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`) ?? ""
  const count = async (selector: string) =>
    await host.queryRenderer<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`) ?? 0

  // Every check runs and reports independently. A single `throw` would abort the run at
  // the first failure and hide whether the later checks would have caught the same bug,
  // which is exactly what happened when the echo check preceded the surface checks.
  const failures: string[] = []
  const check = async (label: string, fn: () => Promise<string | null>) => {
    try {
      const problem = await fn()
      if (problem) {
        failures.push(`${label}: ${problem}`)
        console.log(`GUI smoke FAIL: ${label}: ${problem}`)
      } else {
        console.log(`GUI smoke OK: ${label}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${label}: threw ${message}`)
      console.log(`GUI smoke FAIL: ${label}: threw ${message}`)
    }
  }

  await settleFrame()

  // Surfaces first: these are the canvas/html flicker symptoms, and they must be
  // exercised even if some other assertion is broken.
  await check("canvas surface painted", () =>
    surfaceProblem(editor, host, ["canvas-demo", "sine"], "canvas.web-surface-canvas", "canvas"))
  await check("html surface painted", () =>
    surfaceProblem(editor, host, ["html-demo", "article"], ".web-surface-root .web-node", "html"))

  // Frame chrome: proof `syncFrames` alone still paints the whole window.
  await check("frame chrome painted", async () => {
    if (!(await text("#jemacs-title")).trim()) return "no title"
    if (await count(".window-pane") < 2) return "fewer panes than the split created"
    if (await count("#jemacs-minibuffer") === 0) return "missing minibuffer"
    if (await count("#jemacs-echo") === 0) return "missing echo area"
    return null
  })

  // Body rows survive cursor movement, and nothing stale accumulates.
  //
  // `renderBodyRows` now reconciles rows in place rather than replacing the subtree, so
  // it is responsible for sweeping children the old `replaceChildren` used to clear for
  // free. This walks the cursor and checks the body stays well-formed: rows present, and
  // exactly one block cursor. (The GUI draws the cursor as a U+2588 glyph inside the
  // text, not as a separate caret element -- `pane.cursor` and `renderCaret` are only
  // reachable from hosts that set that field, which this build does not.)
  await check("text body stable across cursor movement", async () => {
    await editor.run("switch-to-buffer", ["smoke"])
    await editor.changed("gui-smoke-text-body")
    await settleFrame()
    if (await count(".window-body .body-row") === 0) return "no body rows"
    for (let i = 0; i < 4; i++) {
      await editor.run("forward-char")
      await editor.changed(`gui-smoke-caret-${i}`)
      await settleFrame()
      if (await count(".window-body .body-row") === 0) return `body rows vanished on repaint ${i}`
      const strays = await count(".window-body > :not(.body-row)")
      if (strays !== 0) return `${strays} stray non-row children after repaint ${i}`
      const blocks = await host.queryRenderer<number>(
        `(document.querySelector(".window-pane.selected .window-body")?.textContent ?? "")`
        + `.split("\\u2588").length - 1`,
      ) ?? 0
      if (blocks !== 1) return `expected exactly 1 block cursor after repaint ${i}, found ${blocks}`
    }
    return null
  })

  // Tab bar: `s-t` must create a tab and the bar must actually appear in the
  // DOM. A green unit suite proves only the model, not that the row is drawn.
  await check("tab bar painted after Cmd-T", async () => {
    const before = editor.tabs.length
    await editor.handleKey({ name: "t", super: true })
    await editor.changed("gui-smoke-tab-new")
    await settleFrame()
    if (editor.tabs.length !== before + 1) return "s-t did not create a tab"
    const bar = (await text("#jemacs-tab-bar")).trim()
    if (!bar) return "tab bar element is empty"
    if (!bar.includes("+")) return `tab bar has no new-tab button: ${JSON.stringify(bar)}`

    // Clicking the bar must reach the editor. This is the only check that
    // proves the renderer's listener, the IPC hop, and the hit test all line up.
    // Column 0 is the separator, so aim at column 1: the first tab's name. The
    // bar is monospace, so one Range over its text gives the character width.
    const clicked = await host.queryRenderer<boolean>(`(() => {
      const el = document.getElementById("jemacs-tab-bar")
      if (!el) return false
      const range = document.createRange()
      range.selectNodeContents(el)
      const text = range.getBoundingClientRect()
      const charWidth = text.width / (el.textContent.length || 1)
      el.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true, button: 0,
        clientX: text.left + charWidth * 1.5, clientY: text.top + text.height / 2,
      }))
      return true
    })()`)
    if (!clicked) return "tab bar element missing when clicking"
    await settleFrame()
    if (editor.selectedTab !== 0) return `click on the first tab selected ${editor.selectedTab}`

    await editor.handleKey({ name: "w", super: true })
    await editor.changed("gui-smoke-tab-close")
    await settleFrame()
    if (editor.tabs.length !== before) return "s-w did not close the tab"
    return null
  })

  // Echo area: the message must survive redisplay. This is the field the duplicate
  // capability-less render path used to blank on alternate frames.
  await check("echo message painted", async () => {
    editor.message("smoke-echo-probe")
    await editor.changed("gui-smoke-echo")
    await settleFrame()
    return (await text("#jemacs-echo")).includes("smoke-echo-probe")
      ? null
      : "echo message missing"
  })

  if (failures.length) {
    throw new Error(`GUI smoke failures:\n  - ${failures.join("\n  - ")}`)
  }
}

/**
 * Open a web-surface demo and report why the renderer is not drawing the surface, or
 * null if it drew it and kept drawing it across several redisplays.
 */
async function surfaceProblem(
  editor: Editor,
  host: ElectronHost,
  // Demo name passed explicitly: with no argument these commands prompt through the
  // minibuffer, which would hang a non-interactive smoke run.
  [command, demo]: [string, string],
  selector: string,
  label: string,
): Promise<string | null> {
  await editor.run(command, [demo])
  await editor.changed(`gui-smoke-${label}`)
  await settleFrame()

  const present = async () =>
    await host.queryRenderer<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`) ?? 0

  if (await present() === 0) return "renderer fell back to text instead of drawing the surface"
  // Several redisplays in a row: a surface that survives one frame but not the next is
  // the flicker this smoke test exists to catch.
  for (let i = 0; i < 4; i++) {
    await editor.changed(`gui-smoke-${label}-repaint-${i}`)
    await settleFrame()
    if (await present() === 0) return `surface disappeared on repaint ${i} -- flicker`
  }
  return null
}

async function main(): Promise<void> {
  installDefaultModes()
  const editor = new Editor()
  const argv = process.argv
  const args = parseStartupArgs(argv)
  const evaluator = installDefaultConfig(editor)
  // This is the GUI entry point (src/main.ts handles the TUI), so the GUI-only
  // chords must be layered on here too or they stay unbound under Electron.
  bindGuiKeybindings(editor)
  for (const config of args.configs) await loadStartupConfig(editor, evaluator, config)
  installLspMode(editor)
  installDefaultHooks(editor)
  installXref(editor)
  await installBuiltinPlugins(editor)
  await installUserConfig(editor, evaluator)
  await loadCustomFile(editor, evaluator)

  const host = new ElectronHost()
  const binding = await runJemacsCore(editor, host)

  // `runJemacsCore` already drives redisplay through `host.syncFrames`, which
  // mirrors the kernel's frame list onto OS windows and renders each frame from
  // its own window tree. Registering another "changed" listener here would paint
  // every frame twice per redisplay.
  host.onFrameClosed(frameId => {
    if (editor.frames.some(frame => frame.id === frameId)) editor.deleteFrame(frameId)
  })
  host.onRendererReady(() => {
    host.syncFrames(editor.frames, binding.modelFor)
  })

  // Bind the window before visiting a command-line file so TRAMP can display
  // host-key and password prompts during startup.
  const file = args.files[0]
  if (file) {
    try {
      await editor.openFile(file)
    } catch (error) {
      editor.message(error instanceof Error ? error.message : String(error))
    }
  }

  if (argv.includes("--smoke-gui")) {
    try {
      await runGuiSmokeTest(editor, host)
    } catch (error) {
      // A failing smoke run must still tear the window down. Without this the
      // assertion error propagates but Electron keeps the window open and the
      // process never exits, so CI (and a bisection) hangs instead of reporting.
      console.error(error)
      process.exitCode = 1
      host.destroy()
      app.quit()
    }
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
  app.quit()
})
