import { expect, test } from "bun:test"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { findPaneInModel } from "../../src/display/find-pane"
import type { SpawnHandle, SpawnOptions } from "../../src/platform/runtime"
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
