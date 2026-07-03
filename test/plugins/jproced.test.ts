import { expect, test } from "bun:test"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { findPaneInModel } from "../../src/display/find-pane"
import type { BufferModel } from "../../src/kernel/buffer"
import { modeFeature } from "../../src/modes/mode"
import type { SpawnHandle, SpawnOptions } from "../../src/platform/runtime"
import { getCustom, setCustom } from "../../src/runtime/custom"
import { makeEditor } from "./helper"
import { install, parsePs, type JProcedProcess, type JProcedProvider } from "../../plugins/jproced"

const user = process.env.USER ?? ""

function proc(pid: number, ppid: number, args: string, attrs: Partial<JProcedProcess["attrs"]> = {}): JProcedProcess {
  return {
    pid,
    attrs: {
      pid,
      ppid,
      pgrp: ppid,
      sess: ppid,
      euid: 501,
      user,
      state: "S",
      pri: 31,
      nice: 0,
      thcount: 1,
      vsize: 100000,
      rss: 2000 + pid,
      pcpu: pid / 10,
      pmem: pid / 100,
      etime: "00:01",
      comm: args.split(/\s+/)[0],
      args,
      ...attrs,
    },
  }
}

function provider(processes: JProcedProcess[]): JProcedProvider {
  return { list: async () => processes.map(p => ({ pid: p.pid, attrs: { ...p.attrs } })) }
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode(text))
      ctrl.close()
    },
  })
}

function fakeSpawn(calls: SpawnOptions[]): (opts: SpawnOptions) => SpawnHandle {
  return opts => {
    calls.push(opts)
    return {
      stdin: null,
      stdout: streamOf(""),
      stderr: streamOf(""),
      exited: Promise.resolve(0),
      kill() {},
    }
  }
}

test("parsePs reads ps output with args in the final field", () => {
  const rows = parsePs("101 1 1 1 501 stephen S 31 0 3 123456 9876 12.5 1.2 01:02 node node server.js --watch\n")
  expect(rows).toHaveLength(1)
  expect(rows[0]!.pid).toBe(101)
  expect(rows[0]!.attrs.user).toBe("stephen")
  expect(rows[0]!.attrs.pcpu).toBe(12.5)
  expect(rows[0]!.attrs.args).toBe("node server.js --watch")
})

test("parsePs supports provider output without a thread-count field", () => {
  const rows = parsePs("101 1 1 1 501 stephen S 31 0 123456 9876 12.5 1.2 01:02 node node server.js --watch\n", { threadCount: false })
  expect(rows).toHaveLength(1)
  expect(rows[0]!.attrs.thcount).toBe(0)
  expect(rows[0]!.attrs.args).toBe("node server.js --watch")
})

test("jproced opens a filtered listing and exposes a rich table surface", async () => {
  const editor = makeEditor()
  install(editor, { provider: provider([
    proc(10, 1, "launchd"),
    proc(20, 10, "bun run src/main.ts", { state: "R", pcpu: 9.5 }),
  ]) })

  await editor.run("jproced")

  const buffer = editor.currentBuffer
  expect(buffer.name).toBe("*JProced*")
  expect(buffer.mode).toBe("jproced-mode")
  expect(buffer.text).toContain("PID")
  expect(buffer.text).toContain("bun run src/main.ts")

  const model = buildDisplayModel(editor, {
    viewport: { rows: 30, cols: 120 },
    hostCapabilities: { unit: "pixels", mouse: true, clipboard: true, osc52: false, richTables: true },
  })
  const pane = findPaneInModel(model.windows, editor.selectedWindowId)
  expect(pane?.tableSurface?.kind).toBe("table")
  expect(pane?.tableSurface?.rows.map(row => row.id)).toContain("20")
  expect(pane?.tableSurface?.columns.some(column => column.sortable)).toBe(true)
})

test("jproced plain header marks the active sort column", async () => {
  const editor = makeEditor()
  install(editor, { provider: provider([proc(10, 1, "launchd"), proc(20, 1, "bun")]) })

  await editor.run("jproced")

  expect(editor.currentBuffer.text.split("\n")[0]).toContain("%CPU▼")
})

test("jproced-dispatch opens the JProced transient", async () => {
  const editor = makeEditor()
  install(editor, { provider: provider([proc(20, 1, "bun")]) })
  await editor.run("jproced")

  await editor.run("jproced-dispatch")

  expect(editor.transient?.definition.name).toBe("jproced")
  expect(editor.minibufferCompletionDisplay?.text).toContain("Marks")
  expect(editor.minibufferCompletionDisplay?.text).toContain("Listing")
  expect(editor.minibufferCompletionDisplay?.text).toContain("Actions")
})

test("jproced sort transient dispatches suffix commands", async () => {
  const editor = makeEditor()
  install(editor, { provider: provider([
    proc(20, 1, "low", { pcpu: 10 }),
    proc(30, 1, "high", { pcpu: 30 }),
  ]) })
  await editor.run("jproced")
  expect(processIds(editor.currentBuffer.text)).toEqual([30, 20])

  await editor.run("jproced-sort-popup")
  expect(editor.transient?.definition.name).toBe("jproced-sort")
  await editor.handleKey({ name: "p", sequence: "p" })

  expect(editor.transient).toBeNull()
  expect(processIds(editor.currentBuffer.text)).toEqual([20, 30])
  expect(editor.currentBuffer.text.split("\n")[0]).toContain("PID▲")
})

test("jproced-help creates a help buffer with grouped key tables", async () => {
  const editor = makeEditor()
  install(editor, { provider: provider([proc(20, 1, "bun")]) })
  await editor.run("jproced")

  await editor.run("jproced-help")

  const buffer = editor.currentBuffer
  expect(buffer.name).toBe("*JProced Help*")
  expect(buffer.mode).toBe("help")
  expect(buffer.text).toContain("Marks")
  expect(buffer.text).toContain("m            jproced-mark")
})

test("jproced contributes listing state to mode-line-misc-info", async () => {
  const editor = makeEditor()
  install(editor, { provider: provider([proc(20, 1, "bun")]) })
  await editor.run("jproced")

  const misc = getCustom<Array<(b: BufferModel) => string>>("mode-line-misc-info") ?? []
  const segment = misc.map(fn => fn(editor.currentBuffer)).find(s => s.includes("%CPU"))

  expect(segment).toBe(" [user | %CPU▼ | short]")
})

test("jproced tree mode renders glyph indentation instead of raw depth", async () => {
  const editor = makeEditor()
  install(editor, { provider: provider([
    proc(10, 1, "root"),
    proc(20, 10, "child"),
    proc(30, 20, "grandchild"),
  ]) })
  await editor.run("jproced")
  await editor.run("jproced-filter-interactive", ["all"])
  await editor.run("jproced-toggle-tree")

  const text = editor.currentBuffer.text
  expect(text).toContain("└─")
  expect(text).not.toMatch(/\b1\s+2\.0\b/)
  expect(text).not.toMatch(/\b2\s+3\.0\b/)
})

test("jproced plain percent cells include bars while table cells stay numeric", async () => {
  const editor = makeEditor()
  install(editor, { provider: provider([proc(20, 1, "bun", { pcpu: 12.5 })]) })
  setCustom("jproced-enable-color-flag", true)

  await editor.run("jproced")

  expect(editor.currentBuffer.text).toMatch(/[▁▂▃▄▅▆▇█]/)

  const model = buildDisplayModel(editor, {
    viewport: { rows: 30, cols: 120 },
    hostCapabilities: { unit: "pixels", mouse: true, clipboard: true, osc52: false, richTables: true },
  })
  const pane = findPaneInModel(model.windows, editor.selectedWindowId)
  expect(pane?.tableSurface?.rows[0]?.cells.pcpu.text).toBe("12.5")
  expect(pane?.tableSurface?.rows[0]?.cells.pcpu.text).not.toMatch(/[▁▂▃▄▅▆▇█]/)
})

test("jproced mouse click on the header sorts by that column", async () => {
  const editor = makeEditor()
  install(editor, { provider: provider([
    proc(10, 1, "high", { pcpu: 30 }),
    proc(20, 1, "low", { pcpu: 10 }),
    proc(30, 1, "mid", { pcpu: 20 }),
  ]) })
  await editor.run("jproced")

  const buffer = editor.currentBuffer
  expect(processIds(buffer.text)).toEqual([10, 30, 20])

  const click = modeFeature("jproced-mode", "mouseClick")
  expect(click).toBeDefined()
  click?.(buffer, buffer.text.indexOf("PID"))

  expect(processIds(buffer.text)).toEqual([10, 20, 30])
  expect(buffer.text.split("\n")[0]).toContain("PID▲")
})

test("jproced marks processes and sends signal or renice operations to marked targets", async () => {
  const calls: Array<{ pid: number; signal: string | number }> = []
  const spawnCalls: SpawnOptions[] = []
  const editor = makeEditor()
  install(editor, {
    provider: provider([proc(20, 10, "bun"), proc(30, 10, "node")]),
    spawn: fakeSpawn(spawnCalls),
    signal: (pid, signal) => { calls.push({ pid, signal }) },
  })
  await editor.run("jproced")

  await editor.run("jproced-mark")
  await editor.run("jproced-send-signal", ["TERM"])
  expect(calls).toEqual([{ pid: 30, signal: "TERM" }])

  await editor.run("jproced-renice", ["5"])
  expect(spawnCalls.at(-1)?.cmd).toEqual(["renice", "5", "-p", "30"])
})

test("jproced confirms before signaling multiple targets", async () => {
  const calls: Array<{ pid: number; signal: string | number }> = []
  const editor = makeEditor()
  install(editor, {
    provider: provider([proc(20, 10, "bun"), proc(30, 10, "node")]),
    signal: (pid, signal) => { calls.push({ pid, signal }) },
  })
  await editor.run("jproced")
  await editor.run("jproced-mark-all")

  editor.prompt = async () => "yes"
  await editor.run("jproced-send-signal", ["TERM"])
  expect(calls).toEqual([{ pid: 30, signal: "TERM" }, { pid: 20, signal: "TERM" }])

  calls.length = 0
  editor.prompt = async () => "no"
  await editor.run("jproced-send-signal", ["KILL"])
  expect(calls).toEqual([])
})

test("jproced tree mode and parent/child marking preserve process relationships", async () => {
  const editor = makeEditor()
  install(editor, { provider: provider([
    proc(10, 1, "root"),
    proc(20, 10, "child"),
    proc(30, 20, "grandchild"),
  ]) })
  await editor.run("jproced")
  await editor.run("jproced-filter-interactive", ["all"])
  await editor.run("jproced-toggle-tree")

  const buffer = editor.currentBuffer
  buffer.point = buffer.text.indexOf("root")
  await editor.run("jproced-mark-children")
  expect(buffer.text).toMatch(/^\* .*root/m)
  expect(buffer.text).toMatch(/^\* .*child/m)
  expect(buffer.text).toMatch(/^\* .*grandchild/m)
})

function processIds(text: string): number[] {
  return text.split("\n").slice(1).filter(Boolean).map(line => Number(line.trim().split(/\s+/)[1]))
}
