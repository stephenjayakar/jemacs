import { afterEach, expect, test } from "bun:test"
import { makeEditor } from "./plugins/helper"
import { setPlatformRuntime, type SpawnOptions } from "../src/platform/runtime"
import { setCustom } from "../src/runtime/custom"

// `select-enable-clipboard` defaults off under `bun test` so the suite never
// clobbers the developer's clipboard; these tests opt in with a fake pbcopy.
afterEach(() => {
  setPlatformRuntime(undefined)
  setCustom("select-enable-clipboard", false)
})

function fakePbcopy(): { copied: string[]; board: { text: string } } {
  const copied: string[] = []
  const board = { text: "" }
  setPlatformRuntime({
    spawnProcess(options: SpawnOptions) {
      let text = ""
      const isCopy = options.cmd[0] === "pbcopy"
      return {
        stdin: {
          write: (chunk: string) => { text += chunk },
          end: () => { if (isCopy) { copied.push(text); board.text = text } },
        },
        stdout: isCopy ? null : new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(board.text))
            controller.close()
          },
        }),
        stderr: null,
        exited: Promise.resolve(0),
        kill: () => {},
      }
    },
  })
  return { copied, board }
}

test("kill-region and kill-ring-save write to the system clipboard", async () => {
  const editor = makeEditor()
  setCustom("select-enable-clipboard", true)
  const { copied } = fakePbcopy()
  const buf = editor.currentBuffer

  buf.setText("foo bar baz", false)
  buf.point = 4
  buf.setMark()
  buf.point = 7
  await editor.run("kill-region")
  await Promise.resolve()
  expect(copied).toEqual(["bar"])

  buf.setText("one two three", false)
  buf.point = 4
  buf.setMark()
  buf.point = 7
  await editor.run("kill-ring-save")
  await Promise.resolve()
  expect(copied).toEqual(["bar", "two"])
})

test("appended kills send the whole accumulated head of the kill ring", async () => {
  const editor = makeEditor()
  setCustom("select-enable-clipboard", true)
  const { copied } = fakePbcopy()
  const buf = editor.currentBuffer
  buf.setText("alpha beta\n", false)
  buf.point = 0

  await editor.run("kill-word")
  await editor.run("kill-word")
  await Promise.resolve()
  expect(copied.at(-1)).toBe("alpha beta")
})

test("yank pulls text another application put on the clipboard", async () => {
  const editor = makeEditor()
  setCustom("select-enable-clipboard", true)
  const { board } = fakePbcopy()
  const buf = editor.currentBuffer

  buf.setText("kill me\n", false)
  buf.point = 0
  await editor.run("kill-line")
  await Promise.resolve()

  // Another application copies text while jemacs is idle.
  board.text = "from safari"

  buf.setText("", false)
  await editor.run("yank")
  expect(buf.text).toBe("from safari")

  // The older kill is still reachable with M-y.
  await editor.run("yank-pop")
  expect(buf.text).toBe("kill me")
})

test("yank does not duplicate the head of the kill ring", async () => {
  const editor = makeEditor()
  setCustom("select-enable-clipboard", true)
  fakePbcopy()
  const buf = editor.currentBuffer

  buf.setText("hello\n", false)
  buf.point = 0
  await editor.run("kill-line")
  await Promise.resolve()

  buf.setText("", false)
  await editor.run("yank")
  expect(buf.text).toBe("hello")

  buf.setText("", false)
  await editor.run("yank")
  await editor.run("yank-pop")
  expect(buf.text).toBe("hello")
})

test("select-enable-clipboard nil keeps kills out of the clipboard", async () => {
  const editor = makeEditor()
  setCustom("select-enable-clipboard", false)
  const { copied } = fakePbcopy()
  const buf = editor.currentBuffer
  buf.setText("hello", false)
  buf.point = 0

  await editor.run("kill-line")
  await Promise.resolve()
  expect(copied).toEqual([])
})
