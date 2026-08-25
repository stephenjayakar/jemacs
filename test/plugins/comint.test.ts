import { describe, expect, test } from "bun:test"
import { install, type ComintProcess, type ComintSpawnOptions } from "../../plugins/comint"
import { getMode } from "../../src/modes/mode"
import { keySeq } from "../harness"
import { makeEditor } from "./helper"

type FakeProcess = ComintProcess & {
  writes: string[]
  signals: string[]
  emitStdout(text: string): void
  emitStderr(text: string): void
}

function fakeSpawn(handler: (proc: FakeProcess, chunk: string) => void = () => {}) {
  const calls: ComintSpawnOptions[] = []
  const processes: FakeProcess[] = []
  const encoder = new TextEncoder()

  const spawn = (opts: ComintSpawnOptions): ComintProcess => {
    calls.push(opts)
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null
    let stderrController: ReadableStreamDefaultController<Uint8Array> | null = null
    const proc: FakeProcess = {
      pid: processes.length + 1,
      writes: [],
      signals: [],
      stdin: {
        write(chunk) {
          proc.writes.push(chunk)
          handler(proc, chunk)
        },
        end() {
          proc.signals.push("EOF")
        },
      },
      stdout: new ReadableStream({
        start(controller) {
          stdoutController = controller
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          stderrController = controller
        },
      }),
      exited: new Promise(() => {}),
      kill(signal = "SIGTERM") {
        proc.signals.push(signal)
      },
      emitStdout(text) {
        stdoutController?.enqueue(encoder.encode(text))
      },
      emitStderr(text) {
        stderrController?.enqueue(encoder.encode(text))
      },
    }
    processes.push(proc)
    return proc
  }

  return { spawn, calls, processes }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 25; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  expect(predicate()).toBe(true)
}

describe("comint plugin", () => {
  test("install registers comint and shell modes, commands, and key bindings", () => {
    const editor = makeEditor()
    install(editor)

    expect(editor.commands.get("shell")).toBeDefined()
    expect(editor.commands.get("comint-send-input")).toBeDefined()
    expect(editor.commands.get("comint-previous-input")).toBeDefined()
    expect(editor.commands.get("comint-interrupt-subjob")).toBeDefined()

    const comint = getMode("comint-mode")
    expect(comint?.parent).toBe("text")
    expect(comint?.keymap?.get("return")).toBe("comint-send-input")
    expect(comint?.keymap?.get("M-p")).toBe("comint-previous-input")
    expect(comint?.keymap?.get("C-c C-c")).toBe("comint-interrupt-subjob")

    const shell = getMode("shell-mode")
    expect(shell?.parent).toBe("comint-mode")
  })

  test("shell starts a comint buffer, sends input, appends output before the prompt, and recalls history", async () => {
    const fake = fakeSpawn((proc, chunk) => {
      if (chunk === "echo hi\n") proc.emitStdout("hi\n")
    })
    const editor = makeEditor()
    install(editor, { spawn: fake.spawn, shell: ["bash", "--noprofile", "--norc", "-i"], prompt: "$ " })

    await editor.run("shell")

    const buffer = editor.currentBuffer
    expect(buffer.name).toBe("*shell*")
    expect(buffer.mode).toBe("shell-mode")
    expect(buffer.text).toBe("$ ")
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.cmd).toEqual(["bash", "--noprofile", "--norc", "-i"])
    expect(fake.calls[0]?.stdin).toBe("pipe")
    expect(fake.calls[0]?.stdout).toBe("pipe")
    expect(fake.calls[0]?.stderr).toBe("pipe")

    for (const ch of "echo hi") {
      await editor.handleKey({ name: ch === " " ? "space" : ch, sequence: ch })
    }
    await keySeq(editor, "RET")

    await waitFor(() => buffer.text.includes("hi\n$ "))
    expect(fake.processes[0]?.writes).toEqual(["echo hi\n"])
    expect(buffer.text).toBe("$ echo hi\nhi\n$ ")
    expect(buffer.point).toBe(buffer.text.length)

    await keySeq(editor, "M-p")

    expect(buffer.text).toBe("$ echo hi\nhi\n$ echo hi")
    expect(buffer.point).toBe(buffer.text.length)
  })

  test("comint control commands send SIGINT, EOF, and kill input", async () => {
    const fake = fakeSpawn()
    const editor = makeEditor()
    install(editor, { spawn: fake.spawn })

    await editor.run("shell")
    for (const ch of "partial") {
      await editor.handleKey({ name: ch, sequence: ch })
    }
    await keySeq(editor, "C-c", "C-u")
    expect(editor.currentBuffer.text).toBe("$ ")

    await keySeq(editor, "C-c", "C-c")
    await keySeq(editor, "C-c", "C-d")
    expect(fake.processes[0]?.signals).toEqual(["SIGINT", "EOF"])
  })
})
