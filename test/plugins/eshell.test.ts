import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { install, type EshellProcess, type EshellSpawnOptions } from "../../plugins/eshell"
import type { Editor } from "../../src/kernel/editor"
import { keySeq } from "../harness"
import { makeEditor } from "./helper"

let dir: string

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "jemacs-eshell-")))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      if (bytes.length) controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function typeText(editor: Editor, text: string): Promise<void> {
  for (const ch of text) {
    await editor.handleKey({ name: ch === " " ? "space" : ch, sequence: ch })
  }
}

async function submit(editor: Editor, text: string): Promise<void> {
  await typeText(editor, text)
  await keySeq(editor, "RET")
}

describe("eshell plugin", () => {
  test("cd, pwd, and echo built-ins work without spawning processes", async () => {
    const spawnCalls: EshellSpawnOptions[] = []
    const editor = makeEditor()
    install(editor, {
      spawn(opts) {
        spawnCalls.push(opts)
        throw new Error("unexpected spawn")
      },
    })

    await editor.run("eshell")
    const buffer = editor.currentBuffer
    await submit(editor, `cd ${dir}`)
    await submit(editor, "pwd")
    await submit(editor, "echo hello world")

    expect(spawnCalls).toHaveLength(0)
    expect(buffer.text).toContain(`pwd\n${resolve(dir)}\n`)
    expect(buffer.text).toContain("echo hello world\nhello world\n")

    await keySeq(editor, "M-p")
    expect(buffer.text.endsWith("echo hello world")).toBe(true)
  })

  test("external command output appends before the next prompt", async () => {
    const calls: EshellSpawnOptions[] = []
    const editor = makeEditor()
    install(editor, {
      spawn(opts): EshellProcess {
        calls.push(opts)
        return {
          stdout: streamFrom("external output\n"),
          stderr: null,
          exited: Promise.resolve(0),
        }
      },
    })

    await editor.run("eshell")
    await submit(editor, `cd ${dir}`)
    await submit(editor, "fake-command arg")

    const buffer = [...editor.buffers.values()].find(candidate => candidate.name === "*eshell*")!
    expect(calls).toHaveLength(1)
    expect(calls[0]?.cmd).toEqual(["fake-command", "arg"])
    expect(calls[0]?.cwd).toBe(resolve(dir))
    expect(buffer.text).toContain("fake-command arg\nexternal output\n")
    expect(buffer.text.endsWith(" $ ")).toBe(true)
  })

  test("find-file dispatches to the editor command and opens a buffer", async () => {
    const path = join(dir, "note.txt")
    await writeFile(path, "hello from eshell\n")
    const editor = makeEditor()
    install(editor)

    await editor.run("eshell")
    await submit(editor, `cd ${dir}`)
    await submit(editor, "find-file note.txt")

    expect(editor.currentBuffer.path).toBe(resolve(path))
    expect(editor.currentBuffer.text).toBe("hello from eshell\n")
    const eshell = [...editor.buffers.values()].find(candidate => candidate.name === "*eshell*")!
    expect(eshell.text).toContain("find-file note.txt\n")
    expect(eshell.text.endsWith(" $ ")).toBe(true)
  })
})
