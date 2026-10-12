import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { clearHooks } from "../../src/kernel/hooks"
import { setCustom } from "../../src/runtime/custom"
import {
  cancelTimer,
  cancelFunctionTimers,
  install,
  recentfList,
  recentfLoadList,
  recentfPush,
  recentfSaveList,
  runAtTime,
  runWithIdleTimer,
  savehistLoad,
  savehistSave,
} from "../../plugins/persist"

let dir: string

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

beforeEach(async () => {
  clearHooks()
  recentfList.length = 0
  dir = await mkdtemp(join(tmpdir(), "jemacs-persist-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// ---- timers ---------------------------------------------------------------

test("runAtTime fires once after the given delay", async () => {
  let n = 0
  const t = runAtTime(0.01, null, () => { n++ })
  expect(n).toBe(0)
  await sleep(30)
  expect(n).toBe(1)
  await sleep(20)
  expect(n).toBe(1)
  cancelTimer(t)
})

test("runAtTime with repeat fires multiple times", async () => {
  let n = 0
  const t = runAtTime(0.01, 0.01, () => { n++ })
  await sleep(50)
  expect(n).toBeGreaterThanOrEqual(2)
  cancelTimer(t)
  const frozen = n
  await sleep(30)
  expect(n).toBe(frozen)
})

test("runAtTime passes args and null time means now", async () => {
  let got: unknown[] = []
  runAtTime(null, null, (...a) => { got = a }, "x", 7)
  await sleep(10)
  expect(got).toEqual(["x", 7])
})

test("cancelTimer prevents a pending run-at-time from firing", async () => {
  let n = 0
  const t = runAtTime(0.03, null, () => { n++ })
  cancelTimer(t)
  await sleep(50)
  expect(n).toBe(0)
})

test("runWithIdleTimer fires after idle and resets on activity", async () => {
  const editor = makeEditor()
  await install(editor)
  let n = 0
  const t = runWithIdleTimer(0.03, true, () => { n++ })
  await sleep(15)
  await editor.changed("test-activity")
  await sleep(15)
  await editor.changed("test-activity")
  await sleep(15)
  expect(n).toBe(0)
  await sleep(40)
  expect(n).toBe(1)
  cancelTimer(t)
})

test("runWithIdleTimer non-repeat fires once then deactivates", async () => {
  const editor = makeEditor()
  await install(editor)
  let n = 0
  const t = runWithIdleTimer(0.01, false, () => { n++ })
  await sleep(25)
  expect(n).toBe(1)
  await editor.changed("test-activity")
  await sleep(25)
  expect(n).toBe(1)
  cancelTimer(t)
})

test("cancelFunctionTimers removes all timers for a function", async () => {
  let n = 0
  const fn = () => { n++ }
  runAtTime(0.02, null, fn)
  runWithIdleTimer(0.02, false, fn)
  cancelFunctionTimers(fn)
  await sleep(40)
  expect(n).toBe(0)
})

// ---- savehist -------------------------------------------------------------

test("savehist round-trips minibuffer histories through JSON", async () => {
  const editor = makeEditor()
  await install(editor)
  setCustom("savehist-file", join(dir, "history.json"))

  editor.minibufferHistory.set("file", ["/a", "/b"])
  editor.minibufferHistory.set("M-x", ["find-file"])
  await savehistSave(editor)

  const raw = JSON.parse(await readFile(join(dir, "history.json"), "utf8")) as Record<string, string[]>
  expect(raw.file).toEqual(["/a", "/b"])
  expect(raw["M-x"]).toEqual(["find-file"])

  const fresh = makeEditor()
  await install(fresh)
  setCustom("savehist-file", join(dir, "history.json"))
  fresh.minibufferHistory.clear()
  await savehistLoad(fresh)
  expect(fresh.minibufferHistory.get("file")).toEqual(["/a", "/b"])
  expect(fresh.minibufferHistory.get("M-x")).toEqual(["find-file"])
})

test("savehist-save command writes the file", async () => {
  const editor = makeEditor()
  await install(editor)
  setCustom("savehist-file", join(dir, "history.json"))
  editor.minibufferHistory.set("query", ["hello"])
  await editor.run("savehist-save")
  const raw = JSON.parse(await readFile(join(dir, "history.json"), "utf8")) as Record<string, string[]>
  expect(raw.query).toEqual(["hello"])
})

test("savehistLoad ignores a missing or malformed file", async () => {
  const editor = makeEditor()
  await install(editor)
  setCustom("savehist-file", join(dir, "nope.json"))
  await savehistLoad(editor)
  await writeFile(join(dir, "bad.json"), "{not json", "utf8")
  setCustom("savehist-file", join(dir, "bad.json"))
  await savehistLoad(editor)
})

// ---- recentf --------------------------------------------------------------

test("recentfPush moves an existing entry to the front and dedupes", () => {
  recentfPush("/a")
  recentfPush("/b")
  recentfPush("/c")
  expect(recentfList).toEqual(["/c", "/b", "/a"])
  recentfPush("/a")
  expect(recentfList).toEqual(["/a", "/c", "/b"])
})

test("recentfPush caps at recentf-max-saved-items", async () => {
  const editor = makeEditor()
  await install(editor)
  setCustom("recentf-max-saved-items", 3)
  recentfList.length = 0
  for (const p of ["/a", "/b", "/c", "/d"]) recentfPush(p)
  expect(recentfList).toEqual(["/d", "/c", "/b"])
})

test("find-file-hook records the opened file when recentf-mode is on", async () => {
  const editor = makeEditor()
  await install(editor)
  setCustom("recentf-max-saved-items", 20)
  recentfList.length = 0
  expect(editor.globalMinorModes.has("recentf-mode")).toBe(true)

  const path = join(dir, "note.txt")
  await writeFile(path, "hi", "utf8")
  await editor.openFile(path)
  expect(recentfList[0]).toBe(path)

  const path2 = join(dir, "other.txt")
  await writeFile(path2, "yo", "utf8")
  await editor.openFile(path2)
  expect(recentfList).toEqual([path2, path])
})

test("recentf save/load round-trip", async () => {
  const editor = makeEditor()
  await install(editor)
  setCustom("recentf-save-file", join(dir, "recentf.json"))
  recentfList.length = 0
  recentfPush("/x")
  recentfPush("/y")
  await recentfSaveList()

  recentfList.length = 0
  await recentfLoadList()
  expect(recentfList).toEqual(["/y", "/x"])
})

test("recentf-open prompts with the recent list and visits the chosen file", async () => {
  const editor = makeEditor()
  await install(editor)
  recentfList.length = 0
  const path = join(dir, "pick.txt")
  await writeFile(path, "body", "utf8")
  recentfPush(path)
  recentfPush(join(dir, "other.txt"))

  let seen: string[] | undefined
  editor.completingRead = (_prompt, options) => {
    seen = options.collection
    return Promise.resolve(path)
  }
  await editor.run("recentf-open")
  expect(seen).toEqual([join(dir, "other.txt"), path])
  expect(editor.currentBuffer.path).toBe(path)
  expect(editor.currentBuffer.text).toBe("body")
})

test("recentf-open with empty list just messages", async () => {
  const editor = makeEditor()
  await install(editor)
  recentfList.length = 0
  let called = false
  editor.completingRead = () => {
    called = true
    return Promise.resolve(null)
  }
  await editor.run("recentf-open")
  expect(called).toBe(false)
})

test("recentf-open-files lists entries in a scratch buffer", async () => {
  const editor = makeEditor()
  await install(editor)
  recentfList.length = 0
  recentfPush("/one")
  recentfPush("/two")
  await editor.run("recentf-open-files")
  expect(editor.currentBuffer.name).toBe("*Open Recent*")
  expect(editor.currentBuffer.text).toContain("/two")
  expect(editor.currentBuffer.text).toContain("/one")
})

test("idle autosave flushes both savehist and recentf", async () => {
  const editor = makeEditor()
  await install(editor)
  setCustom("savehist-file", join(dir, "history.json"))
  setCustom("recentf-save-file", join(dir, "recentf.json"))
  recentfList.length = 0
  editor.minibufferHistory.set("file", ["/z"])
  recentfPush("/z")

  let n = 0
  const t = runWithIdleTimer(0.01, true, async () => {
    await savehistSave(editor)
    await recentfSaveList()
    n++
  })
  try {
    // Wait for the first flush instead of a fixed sleep: on a loaded machine
    // the 10ms timer plus two file writes can take far longer than 30ms.
    for (const deadline = Date.now() + 5000; n === 0 && Date.now() < deadline;) await sleep(10)
    expect(n).toBeGreaterThanOrEqual(1)
    const hist = JSON.parse(await readFile(join(dir, "history.json"), "utf8")) as Record<string, string[]>
    expect(hist.file).toEqual(["/z"])
    const recent = JSON.parse(await readFile(join(dir, "recentf.json"), "utf8")) as string[]
    expect(recent).toEqual(["/z"])
  } finally {
    // A timer left running rewrites history.json under the next test.
    cancelTimer(t)
  }
})

test("install loads persisted state from disk", async () => {
  await writeFile(join(dir, "history.json"), JSON.stringify({ file: ["/loaded"] }), "utf8")
  await writeFile(join(dir, "recentf.json"), JSON.stringify(["/loaded.txt"]), "utf8")

  const editor = makeEditor()
  await install(editor)
  setCustom("savehist-file", join(dir, "history.json"))
  setCustom("recentf-save-file", join(dir, "recentf.json"))
  await savehistLoad(editor)
  await recentfLoadList()

  expect(editor.minibufferHistory.get("file")).toEqual(["/loaded"])
  expect(recentfList).toEqual(["/loaded.txt"])
  expect(editor.globalMinorModes.has("savehist-mode")).toBe(true)
  expect(editor.globalMinorModes.has("recentf-mode")).toBe(true)
})
