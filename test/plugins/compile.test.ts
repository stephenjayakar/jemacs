import { beforeAll, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { makeEditor } from "./helper"
import {
  install,
  compilationStart,
  compilationErrorRegexpAlist,
  parseCompilationOutput,
  compilationErrorLineTarget,
  stripAnsi,
  lastCompileCommand,
  lastCompileDirectory,
  type CompileDeps,
} from "../../plugins/compile"
import { install as installNextError, locationList, locationIndex } from "../../plugins/next-error"
import { getMode } from "../../src/modes/mode"
import type { SpawnHandle, SpawnOptions } from "../../src/platform/runtime"

let dir: string
let srcA: string
let srcB: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jemacs-compile-"))
  srcA = join(dir, "a.c")
  srcB = join(dir, "b.py")
  await writeFile(srcA, "int main(void) {\n  return x;\n}\n")
  await writeFile(srcB, "def f():\n    raise ValueError\n\nf()\n")
  await writeFile(join(dir, ".git"), "")
})

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c))
      ctrl.close()
    },
  })
}

function fakeSpawn(behavior: (opts: SpawnOptions) => { stdout?: string[]; stderr?: string[]; code?: number }) {
  const calls: SpawnOptions[] = []
  const spawn = (opts: SpawnOptions): SpawnHandle => {
    calls.push(opts)
    const r = behavior(opts)
    return {
      stdin: null,
      stdout: streamOf(r.stdout ?? []),
      stderr: streamOf(r.stderr ?? []),
      exited: Promise.resolve(r.code ?? 0),
      kill: () => {},
    }
  }
  return { spawn, calls }
}

test("compilationErrorRegexpAlist covers common Emacs compilation patterns", () => {
  const names = compilationErrorRegexpAlist.map(r => r.name)
  expect(names).toContain("gcc-include")
  expect(names).toContain("gnu")
  expect(names).toContain("rustc")
  expect(names).toContain("cargo-test-panic")
  expect(names).toContain("msft")
  expect(names).toContain("python-tracebacks")
  expect(names).toContain("node-stack")
  expect(names).toContain("tsc")
  expect(names).toContain("go")
  expect(names).toContain("java")
  expect(names).toContain("java-maven")
})

test("parseCompilationOutput resolves common tool output patterns", () => {
  const cases = [
    {
      name: "gnu error",
      raw: "a.c:2:10: error: use of undeclared identifier 'x'",
      file: join(dir, "a.c"),
      line: 2,
      col: 10,
      severity: "error",
    },
    {
      name: "gnu warning",
      raw: "src/main.rs:5: warning: unused variable",
      file: join(dir, "src/main.rs"),
      line: 5,
      col: 1,
      severity: "warning",
    },
    {
      name: "gcc include",
      raw: "In file included from include/foo.h:3:2,",
      file: join(dir, "include/foo.h"),
      line: 3,
      col: 2,
      severity: "info",
    },
    {
      name: "rust",
      raw: "  --> src/lib.rs:14:3",
      file: join(dir, "src/lib.rs"),
      line: 14,
      col: 3,
      severity: "info",
    },
    {
      name: "cargo test panic",
      raw: "thread 'tests::it_works' panicked at src/x.rs:10:5:",
      file: join(dir, "src/x.rs"),
      line: 10,
      col: 5,
      severity: "error",
    },
    {
      name: "python traceback",
      raw: '  File "b.py", line 2, in f',
      file: join(dir, "b.py"),
      line: 2,
      col: 1,
      severity: "error",
    },
    {
      name: "node stack",
      raw: "    at Object.<anonymous> (/abs/node.js:10:5)",
      file: "/abs/node.js",
      line: 10,
      col: 5,
      severity: "error",
    },
    {
      name: "bun/jest anonymous stack",
      raw: "    at <anonymous> (/abs/test.ts:11:6)",
      file: "/abs/test.ts",
      line: 11,
      col: 6,
      severity: "error",
    },
    {
      name: "tsc",
      raw: "src/app.ts(7,12): error TS2304: Cannot find name 'foo'.",
      file: join(dir, "src/app.ts"),
      line: 7,
      col: 12,
      severity: "error",
    },
    {
      name: "go",
      raw: "./main.go:10:5: undefined: thing",
      file: join(dir, "main.go"),
      line: 10,
      col: 5,
      severity: "error",
    },
    {
      name: "java",
      raw: "src/App.java:12: warning: [deprecation] old() has been deprecated",
      file: join(dir, "src/App.java"),
      line: 12,
      col: 1,
      severity: "warning",
    },
    {
      name: "maven java",
      raw: `[ERROR] ${join(dir, "src/App.java")}:[42,9] cannot find symbol`,
      file: join(dir, "src/App.java"),
      line: 42,
      col: 9,
      severity: "error",
    },
  ] as const

  for (const c of cases) {
    const locs = parseCompilationOutput(c.raw, dir)
    expect(locs).toEqual([{
      file: c.file,
      line: c.line,
      col: c.col,
      text: c.raw.trim(),
      severity: c.severity,
    }])
  }
})

test("parseCompilationOutput skips timestamps and non-file lines", () => {
  const locs = parseCompilationOutput("12:34:56 build started\nno colons here\n", "/tmp")
  expect(locs).toEqual([])
})

test("stripAnsi removes CSI SGR and OSC escape sequences", () => {
  const text = "\x1b[31merror\x1b[0m plain \x1b]8;;https://example.test\x07link\x1b]8;;\x07"
  expect(stripAnsi(text)).toBe("error plain link")
  expect(parseCompilationOutput("\x1b[31ma.c:2:10: error: x\x1b[0m", dir)).toEqual([{
    file: srcA,
    line: 2,
    col: 10,
    text: "a.c:2:10: error: x",
    severity: "error",
  }])
})

test("install registers commands and compilation mode keymap", () => {
  const editor = makeEditor()
  install(editor)
  expect(editor.commands.get("compile")).toBeDefined()
  expect(editor.commands.get("recompile")).toBeDefined()
  expect(editor.commands.get("kill-compilation")).toBeDefined()
  const mode = getMode("compilation")
  expect(mode).toBeDefined()
  expect(mode?.keymap?.get("g")).toBe("recompile")
  expect(mode?.keymap?.get("enter")).toBe("compile-goto-error")
  expect(mode?.keymap?.get("C-c C-k")).toBe("kill-compilation")
  expect(mode?.keymap?.get("n")).toBe("compilation-next-error")
  expect(mode?.keymap?.get("p")).toBe("compilation-previous-error")
})

test("compile prompts with compile-command history defaulting to make -k", async () => {
  const editor = makeEditor()
  const { spawn } = fakeSpawn(() => ({ stdout: [""], code: 0 }))
  install(editor, { spawn, projectRoot: async () => dir })

  const pending = editor.run("compile")
  await Promise.resolve()
  expect(editor.minibuffer).not.toBeNull()
  expect(editor.minibuffer?.prompt).toBe("Compile command: ")
  expect(editor.minibuffer?.historyName).toBe("compile-command")
  expect(editor.activeBuffer.text).toBe("make -k ")
  editor.minibufferCancel()
  await pending

  expect(editor.minibufferHistory.get("compile-command")).toBeUndefined()
})

test("compile spawns via shell in project root, streams output, populates location list", async () => {
  const editor = makeEditor()
  installNextError(editor)
  const stderr = [
    "a.c:2:10: error: ",
    "use of undeclared identifier 'x'\n",
    "1 error generated.\n",
  ]
  const { spawn, calls } = fakeSpawn(() => ({ stderr, code: 1 }))
  const deps: CompileDeps = { spawn, projectRoot: async p => (expect(p).toBe(srcA), dir) }
  install(editor, deps)

  await editor.openFile(srcA)
  await editor.run("compile", ["cc -c a.c"])

  expect(calls.length).toBe(1)
  expect(calls[0]!.cmd).toEqual(["sh", "-c", "cc -c a.c"])
  expect(calls[0]!.cwd).toBe(dir)

  const buf = editor.currentBuffer
  expect(buf.name).toBe("*compilation*")
  expect(buf.mode).toBe("compilation")
  expect(buf.readOnly).toBe(true)
  expect(buf.text).toContain(`default-directory: ${JSON.stringify(dir)}`)
  expect(buf.text).toContain("cc -c a.c")
  expect(buf.text).toContain("a.c:2:10: error: use of undeclared identifier 'x'")
  expect(buf.text).toContain("Compilation exited abnormally with code 1")
  expect(buf.locals.get("default-directory")).toBe(dir)

  const locs = locationList(editor)
  expect(locs.length).toBe(1)
  expect(locs[0]).toEqual({
    file: srcA,
    line: 2,
    col: 10,
    text: "a.c:2:10: error: use of undeclared identifier 'x'",
    severity: "error",
  })
  expect(lastCompileCommand(editor)).toBe("cc -c a.c")
  expect(lastCompileDirectory(editor)).toBe(dir)
})

test("compile strips ANSI escapes before inserting and parsing output", async () => {
  const editor = makeEditor()
  installNextError(editor)
  const stderr = [
    "\x1b[31m",
    "a.c:2:10: error: red\x1b[0m\n",
    "\x1b]8;;https://example.test\x07link\x1b]8;;\x07\n",
  ]
  const { spawn } = fakeSpawn(() => ({ stderr, code: 1 }))
  install(editor, { spawn, projectRoot: async () => dir })

  await editor.openFile(srcA)
  await editor.run("compile", ["cc -c a.c"])

  expect(editor.currentBuffer.text).toContain("a.c:2:10: error: red")
  expect(editor.currentBuffer.text).toContain("link")
  expect(editor.currentBuffer.text).not.toContain("\x1b")
  expect(locationList(editor)).toEqual([{
    file: srcA,
    line: 2,
    col: 10,
    text: "a.c:2:10: error: red",
    severity: "error",
  }])
})

test("next-error visits parsed compilation locations", async () => {
  const editor = makeEditor()
  installNextError(editor)
  const out = `a.c:2:10: error: x\n  File "b.py", line 2\n`
  const { spawn } = fakeSpawn(() => ({ stdout: [out], code: 1 }))
  install(editor, { spawn, projectRoot: async () => dir })

  await editor.openFile(srcA)
  await editor.run("compile", ["make"])
  expect(locationList(editor).length).toBe(2)

  await editor.run("next-error")
  expect(locationIndex(editor)).toBe(0)
  expect(editor.currentBuffer.path).toBe(srcA)
  expect(editor.currentBuffer.lineCol()).toEqual({ line: 2, col: 10 })

  await editor.run("next-error")
  expect(locationIndex(editor)).toBe(1)
  expect(editor.currentBuffer.path).toBe(srcB)
  expect(editor.currentBuffer.lineCol()).toEqual({ line: 2, col: 1 })
})

test("compile-goto-error visits the parsed location at point in *compilation*", async () => {
  const editor = makeEditor()
  installNextError(editor)
  const out = `noise\n  File "b.py", line 2\n`
  const { spawn } = fakeSpawn(() => ({ stdout: [out], code: 1 }))
  install(editor, { spawn, projectRoot: async () => dir })

  await editor.openFile(srcA)
  await editor.run("compile", ["make"])
  const compilation = editor.currentBuffer
  compilation.point = compilation.text.indexOf('File "b.py"')

  await editor.run("compile-goto-error")

  expect(editor.currentBuffer.path).toBe(srcB)
  expect(editor.currentBuffer.lineCol()).toEqual({ line: 2, col: 1 })
  expect(locationIndex(editor)).toBe(0)
})

test("n and p in compilation-mode move between error lines without visiting files", async () => {
  const editor = makeEditor()
  installNextError(editor)
  const out = `a.c:2:10: error: x\nnoise\n  File "b.py", line 2\n`
  const { spawn } = fakeSpawn(() => ({ stdout: [out], code: 1 }))
  install(editor, { spawn, projectRoot: async () => dir })

  await editor.openFile(srcA)
  await editor.run("compile", ["make"])
  const compilation = editor.currentBuffer
  compilation.point = 0
  expect(compilationErrorLineTarget(compilation, 1)).not.toBeNull()

  await editor.handleKey({ name: "n", sequence: "n" })
  expect(editor.currentBuffer).toBe(compilation)
  expect(compilation.text.slice(compilation.point).startsWith("a.c:2:10")).toBe(true)

  await editor.handleKey({ name: "n", sequence: "n" })
  expect(editor.currentBuffer).toBe(compilation)
  expect(compilation.text.slice(compilation.point).startsWith('  File "b.py"')).toBe(true)

  await editor.handleKey({ name: "p", sequence: "p" })
  expect(editor.currentBuffer).toBe(compilation)
  expect(compilation.text.slice(compilation.point).startsWith("a.c:2:10")).toBe(true)
})

test("g in *compilation* runs recompile and reuses the last command/directory", async () => {
  const editor = makeEditor()
  let n = 0
  const { spawn, calls } = fakeSpawn(() => ({ stdout: [`run ${++n}\n`], code: 0 }))
  install(editor, { spawn, projectRoot: async () => dir })

  await editor.openFile(srcA)
  await editor.run("compile", ["echo hi"])
  expect(calls.length).toBe(1)
  expect(editor.currentBuffer.name).toBe("*compilation*")
  expect(editor.currentBuffer.text).toContain("run 1")
  expect(editor.currentBuffer.text).toContain("Compilation finished")

  await editor.handleKey({ name: "g", sequence: "g" })
  expect(calls.length).toBe(2)
  expect(calls[1]!.cmd).toEqual(["sh", "-c", "echo hi"])
  expect(calls[1]!.cwd).toBe(dir)
  expect(editor.currentBuffer.text).toContain("run 2")
  expect(editor.currentBuffer.text).not.toContain("run 1")
})

test("compile records history and second prompt offers the last command", async () => {
  const editor = makeEditor()
  const { spawn } = fakeSpawn(() => ({ code: 0 }))
  install(editor, { spawn, projectRoot: async () => dir })

  let pending = editor.run("compile")
  await Promise.resolve()
  editor.activeBuffer.setText("bun test", true)
  editor.minibufferSubmit()
  await pending
  expect(editor.minibufferHistory.get("compile-command")).toEqual(["bun test"])
  expect(lastCompileCommand(editor)).toBe("bun test")

  editor.switchToBuffer("*scratch*")
  pending = editor.run("compile")
  await Promise.resolve()
  expect(editor.activeBuffer.text).toBe("bun test")
  editor.minibufferCancel()
  await pending
})

test("kill-compilation messages when nothing running", async () => {
  const editor = makeEditor()
  install(editor)
  let msg = ""
  editor.events.on("message", ({ text }) => { msg = text })
  await editor.run("kill-compilation")
  expect(msg).toContain("No compilation process running")
})

test("compilationStart with real shell streams stdout into *compilation*", async () => {
  const editor = makeEditor()
  install(editor)
  const buf = await compilationStart(editor, `printf 'x.c:1:2: error: boom\\n'`, dir)
  expect(buf.name).toBe("*compilation*")
  expect(buf.text).toContain("x.c:1:2: error: boom")
  expect(buf.text).toContain("Compilation finished")
  const locs = locationList(editor)
  expect(locs.length).toBe(1)
  expect(locs[0]!.file).toBe(resolve(dir, "x.c"))
})
