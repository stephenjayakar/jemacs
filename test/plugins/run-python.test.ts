import { expect, test, describe } from "bun:test"
import type { BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { getMode } from "../../src/modes/mode"
import { preparePythonShellInput, type PythonShellFactory, type PythonShellSession } from "../../src/modes/python-shell"
import { setCustom } from "../../src/runtime/custom"
import { makeEditor } from "./helper"

type FakeSession = PythonShellSession & {
  writes: string[]
}

function fakePythonFactory(): PythonShellFactory & {
  calls: Array<{ buffer: BufferModel; argv: string[] }>
  sessions: FakeSession[]
} {
  const calls: Array<{ buffer: BufferModel; argv: string[] }> = []
  const sessions: FakeSession[] = []
  const factory = (async (_editor: Editor, buffer: BufferModel, argv: string[]) => {
    const session: FakeSession = {
      alive: true,
      writes: [],
      writeRaw(bytes) { this.writes.push(bytes) },
    }
    calls.push({ buffer, argv })
    sessions.push(session)
    return session
  }) as PythonShellFactory & { calls: Array<{ buffer: BufferModel; argv: string[] }>; sessions: FakeSession[] }
  factory.calls = calls
  factory.sessions = sessions
  return factory
}

describe("run-python / inferior Python", () => {
  test("python-mode binds Emacs python shell commands", () => {
    makeEditor()
    const map = getMode("python")?.keymap
    expect(map?.get("C-c C-p")).toBe("run-python")
    expect(map?.get("C-c C-r")).toBe("python-shell-send-region")
    expect(map?.get("C-c C-c")).toBe("python-shell-send-buffer")
    expect(map?.get("C-c C-e")).toBe("python-shell-send-defun")
    expect(map?.get("C-M-x")).toBe("python-shell-send-defun")
    expect(map?.get("C-c C-z")).toBe("python-shell-switch-to-shell")
  })

  test("commands are registered by default config", () => {
    const editor = makeEditor()
    expect(editor.commands.get("run-python")).toBeDefined()
    expect(editor.commands.get("python-shell-send-region")).toBeDefined()
    expect(editor.commands.get("python-shell-send-buffer")).toBeDefined()
    expect(editor.commands.get("python-shell-send-defun")).toBeDefined()
    expect(editor.commands.get("python-shell-switch-to-shell")).toBeDefined()
  })

  test("run-python starts python-shell-interpreter -i in *Python* and reuses it", async () => {
    const editor = makeEditor()
    const factory = fakePythonFactory()
    const { installPythonShellCommands } = await import("../../src/modes/python-shell")
    installPythonShellCommands(editor, factory)
    setCustom("python-shell-interpreter", "python-test")

    try {
      await editor.run("run-python")
      await editor.run("run-python")

      expect(factory.calls).toHaveLength(1)
      expect(factory.calls[0]?.argv).toEqual(["python-test", "-i"])
      expect(editor.currentBuffer.name).toBe("*Python*")
    } finally {
      setCustom("python-shell-interpreter", "python3")
    }
  })

  test("python-shell-send-buffer starts the shell and sends wrapped multi-line text", async () => {
    const editor = makeEditor()
    const factory = fakePythonFactory()
    const { installPythonShellCommands } = await import("../../src/modes/python-shell")
    installPythonShellCommands(editor, factory)
    const source = editor.scratch("example.py", "x = 1\nprint(x)\n", "python")

    await editor.run("python-shell-send-buffer")

    expect(factory.calls).toHaveLength(1)
    expect(factory.sessions[0]?.writes).toEqual([preparePythonShellInput(source.text)])
    expect(editor.currentBuffer.name).toBe("example.py")
  })

  test("python-shell-send-region sends only the active region", async () => {
    const editor = makeEditor()
    const factory = fakePythonFactory()
    const { installPythonShellCommands } = await import("../../src/modes/python-shell")
    installPythonShellCommands(editor, factory)
    const source = editor.scratch("example.py", "before\nselected\n", "python")
    source.point = source.text.indexOf("selected")
    source.setMark()
    source.point = source.text.length

    await editor.run("python-shell-send-region")

    expect(factory.sessions[0]?.writes).toEqual([preparePythonShellInput("selected\n")])
  })

  test("python-shell-send-defun sends the current Python defun", async () => {
    const editor = makeEditor()
    const factory = fakePythonFactory()
    const { installPythonShellCommands } = await import("../../src/modes/python-shell")
    installPythonShellCommands(editor, factory)
    const source = editor.scratch("example.py", "def one():\n    return 1\n\ndef two():\n    return 2\n", "python")
    source.point = source.text.indexOf("return 2")

    await editor.run("python-shell-send-defun")

    expect(factory.sessions[0]?.writes).toEqual([preparePythonShellInput("def two():\n    return 2\n")])
  })

  test("python-shell-switch-to-shell displays *Python* in another selected window", async () => {
    const editor = makeEditor()
    const factory = fakePythonFactory()
    const { installPythonShellCommands } = await import("../../src/modes/python-shell")
    installPythonShellCommands(editor, factory)
    editor.scratch("example.py", "print(1)\n", "python")

    await editor.run("python-shell-switch-to-shell")

    expect(factory.calls).toHaveLength(1)
    expect(editor.currentBuffer.name).toBe("*Python*")
  })
})

describe("preparePythonShellInput", () => {
  test("single-line input gets a trailing newline", () => {
    expect(preparePythonShellInput("print(1)")).toBe("print(1)\n")
  })

  test("multi-line input is wrapped for reliable python -i evaluation", () => {
    expect(preparePythonShellInput("def f():\n    return 1\n")).toBe(
      "exec(compile(\"def f():\\n    return 1\\n\", \"<jemacs-python>\", \"exec\"))\n",
    )
  })
})
