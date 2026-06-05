import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Editor } from "../../src/kernel/editor"
import { addHook } from "../../src/kernel/hooks"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { defineMinorMode } from "../../src/modes/minor-mode"

// ---------------------------------------------------------------------------
// Timers (run-at-time / run-with-idle-timer / cancel-timer)
// ---------------------------------------------------------------------------

export type TimerFn = (...args: unknown[]) => unknown

export type Timer = {
  function: TimerFn
  args: unknown[]
  repeat: number | boolean | null
  idle: boolean
  secs: number
  cancel(): void
}

type TimerInternal = Timer & {
  handle: ReturnType<typeof setTimeout> | null
  fired: boolean
}

const timerList: TimerInternal[] = []
const idleTimerList: TimerInternal[] = []
let inTimerEvent = false

function ms(secs: number): number {
  return Math.max(0, secs * 1000)
}

function fire(timer: TimerInternal): void {
  inTimerEvent = true
  try {
    timer.function(...timer.args)
  } catch {
    // swallow so a bad timer doesn't break the loop
  } finally {
    inTimerEvent = false
  }
}

export function runAtTime(time: number | null, repeat: number | null, fn: TimerFn, ...args: unknown[]): Timer {
  const secs = time ?? 0
  const timer: TimerInternal = {
    function: fn,
    args,
    repeat: repeat && repeat > 0 ? repeat : null,
    idle: false,
    secs,
    handle: null,
    fired: false,
    cancel() {
      if (timer.handle) clearTimeout(timer.handle)
      timer.handle = null
      const i = timerList.indexOf(timer)
      if (i >= 0) timerList.splice(i, 1)
    },
  }
  const schedule = (delay: number) => {
    timer.handle = setTimeout(() => {
      timer.fired = true
      fire(timer)
      if (timer.repeat) schedule(ms(timer.repeat as number))
      else timer.cancel()
    }, delay)
  }
  schedule(ms(secs))
  timerList.push(timer)
  return timer
}

export function runWithTimer(secs: number, repeat: number | null, fn: TimerFn, ...args: unknown[]): Timer {
  return runAtTime(secs, repeat, fn, ...args)
}

export function runWithIdleTimer(secs: number, repeat: boolean, fn: TimerFn, ...args: unknown[]): Timer {
  const timer: TimerInternal = {
    function: fn,
    args,
    repeat,
    idle: true,
    secs,
    handle: null,
    fired: false,
    cancel() {
      if (timer.handle) clearTimeout(timer.handle)
      timer.handle = null
      const i = idleTimerList.indexOf(timer)
      if (i >= 0) idleTimerList.splice(i, 1)
    },
  }
  idleTimerList.push(timer)
  armIdle(timer)
  return timer
}

function armIdle(timer: TimerInternal): void {
  if (timer.handle) clearTimeout(timer.handle)
  timer.handle = setTimeout(() => {
    timer.fired = true
    fire(timer)
    if (!timer.repeat) timer.cancel()
    // repeating idle timers wait for the next activity before re-arming
  }, ms(timer.secs))
}

/** Reset idle countdown after user activity. */
function notifyActivity(): void {
  if (inTimerEvent) return
  for (const timer of idleTimerList) {
    timer.fired = false
    armIdle(timer)
  }
}

export function cancelTimer(timer: Timer): void {
  timer.cancel()
}

export function cancelFunctionTimers(fn: TimerFn): void {
  for (const t of [...timerList, ...idleTimerList]) {
    if (t.function === fn) t.cancel()
  }
}

// ---------------------------------------------------------------------------
// savehist
// ---------------------------------------------------------------------------

function savehistFile(): string {
  return getCustom<string>("savehist-file") ?? join(homedir(), ".jemacs", "history.json")
}

export async function savehistSave(editor: Editor): Promise<void> {
  const data: Record<string, string[]> = {}
  for (const [name, entries] of editor.minibufferHistory) data[name] = entries
  const file = savehistFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(data, null, 2), "utf8")
}

export async function savehistLoad(editor: Editor): Promise<void> {
  const file = savehistFile()
  const text = await readFile(file, "utf8").catch(() => null)
  if (!text) return
  let data: Record<string, string[]>
  try {
    data = JSON.parse(text) as Record<string, string[]>
  } catch {
    return
  }
  for (const [name, entries] of Object.entries(data)) {
    if (Array.isArray(entries)) editor.minibufferHistory.set(name, entries.map(String))
  }
}

// ---------------------------------------------------------------------------
// recentf
// ---------------------------------------------------------------------------

export const recentfList: string[] = []

function recentfFile(): string {
  return getCustom<string>("recentf-save-file") ?? join(homedir(), ".jemacs", "recentf.json")
}

function recentfMax(): number {
  return getCustom<number>("recentf-max-saved-items") ?? 20
}

export function recentfPush(path: string): void {
  const i = recentfList.indexOf(path)
  if (i >= 0) recentfList.splice(i, 1)
  recentfList.unshift(path)
  const max = recentfMax()
  if (recentfList.length > max) recentfList.length = max
}

export async function recentfSaveList(): Promise<void> {
  const file = recentfFile()
  await mkdir(dirname(file), { recursive: true })
  const items = recentfList.slice(0, recentfMax())
  await writeFile(file, JSON.stringify(items, null, 2), "utf8")
}

export async function recentfLoadList(): Promise<void> {
  const file = recentfFile()
  const text = await readFile(file, "utf8").catch(() => null)
  if (!text) return
  let items: string[]
  try {
    items = JSON.parse(text) as string[]
  } catch {
    return
  }
  recentfList.length = 0
  if (Array.isArray(items)) recentfList.push(...items.map(String))
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

let autosaveTimer: Timer | null = null

export async function install(editor: Editor): Promise<void> {
  defcustom("savehist-file", "string", join(homedir(), ".jemacs", "history.json"), "File where minibuffer histories are persisted.")
  defcustom("savehist-autosave-interval", "number", 300, "Seconds of idle time before autosaving history.")
  defcustom("recentf-save-file", "string", join(homedir(), ".jemacs", "recentf.json"), "File where the recent file list is persisted.")
  defcustom("recentf-max-saved-items", "number", 20, "Maximum number of recent files to remember.")

  editor.events.on("changed", () => notifyActivity())

  defineMinorMode({ name: "savehist-mode", global: true, lighter: "" })
  defineMinorMode({ name: "recentf-mode", global: true, lighter: "" })

  addHook("find-file-hook", ({ editor, buffer }) => {
    if (!editor.globalMinorModes.has("recentf-mode")) return
    if (buffer.path) recentfPush(buffer.path)
  })

  addHook("kill-emacs-hook", async ({ editor }) => {
    if (editor.globalMinorModes.has("savehist-mode")) await savehistSave(editor)
    if (editor.globalMinorModes.has("recentf-mode")) await recentfSaveList()
  })

  editor.command("savehist-save", async ({ editor }) => {
    await savehistSave(editor)
    editor.message(`Wrote ${savehistFile()}`)
  }, "Save minibuffer histories to savehist-file.")

  editor.command("savehist-mode", ({ editor }) => {
    const on = editor.toggleMinorMode("savehist-mode")
    editor.message(`Savehist mode ${on ? "enabled" : "disabled"}`)
  }, "Toggle persistent minibuffer history.")

  editor.command("recentf-mode", ({ editor }) => {
    const on = editor.toggleMinorMode("recentf-mode")
    editor.message(`Recentf mode ${on ? "enabled" : "disabled"}`)
  }, "Toggle tracking of recently opened files.")

  editor.command("recentf-save-list", async ({ editor }) => {
    await recentfSaveList()
    editor.message(`Wrote ${recentfFile()}`)
  }, "Save the recent file list to recentf-save-file.")

  editor.command("recentf-open", async ({ editor }) => {
    if (!editor.globalMinorModes.has("recentf-mode")) editor.enableMinorMode("recentf-mode")
    if (!recentfList.length) {
      editor.message("No recent files")
      return
    }
    const choice = await editor.completingRead("Open recent file: ", {
      collection: [...recentfList],
      history: "file",
    })
    if (choice) await editor.openFile(choice)
  }, "Prompt for a file from the recent list and visit it.")

  editor.command("recentf-open-files", ({ editor }) => {
    if (!recentfList.length) {
      editor.message("No recent files")
      return
    }
    const body = recentfList.map((f, i) => `${String(i + 1).padStart(3)}  ${f}`).join("\n")
    editor.scratch("*Open Recent*", body, "text")
  }, "Show the recent file list in a buffer.")

  await savehistLoad(editor)
  await recentfLoadList()
  editor.enableMinorMode("savehist-mode")
  editor.enableMinorMode("recentf-mode")

  const idleSecs = getCustom<number>("savehist-autosave-interval") ?? 300
  autosaveTimer?.cancel()
  autosaveTimer = runWithIdleTimer(idleSecs, true, () => {
    if (editor.globalMinorModes.has("savehist-mode")) void savehistSave(editor)
    if (editor.globalMinorModes.has("recentf-mode")) void recentfSaveList()
  })
}
