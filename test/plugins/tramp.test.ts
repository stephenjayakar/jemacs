import { test, expect } from "bun:test"
import { makeEditor } from "./helper"
import { createPluginContext } from "../../src/runtime/plugin-context"
import { diredEntryAtPoint } from "../../src/modes/dired"
import { install, parseTrampFileName, formatTrampFileName, type RemoteTransport, type TrampFileName } from "../../plugins/tramp"

class FakeTransport implements RemoteTransport {
  files = new Map<string, { text: string; mtime: number }>()
  directories = new Set<string>()
  writes: string[] = []

  key(file: TrampFileName): string {
    return `${file.user ?? ""}@${file.host}:${file.port ?? ""}:${file.localname}`
  }

  addFile(name: string, text: string, mtime = 1_000): void {
    const file = parseTrampFileName(name)
    if (!file) throw new Error(`bad tramp name: ${name}`)
    this.files.set(this.key(file), { text, mtime })
    this.addDirectory(formatTrampFileName(file, dirname(file.localname)))
  }

  addDirectory(name: string): void {
    const file = parseTrampFileName(name)
    if (!file) throw new Error(`bad tramp name: ${name}`)
    this.directories.add(this.key(file))
  }

  async fileKind(file: TrampFileName) {
    const key = this.key(file)
    if (this.directories.has(key)) return "directory" as const
    if (this.files.has(key)) return "file" as const
    return "missing" as const
  }

  async readFile(file: TrampFileName): Promise<string> {
    return this.files.get(this.key(file))?.text ?? ""
  }

  async writeFile(file: TrampFileName, text: string): Promise<void> {
    this.writes.push(formatTrampFileName(file))
    this.files.set(this.key(file), { text, mtime: Date.now() })
  }

  async statMtime(file: TrampFileName): Promise<number | undefined> {
    return this.files.get(this.key(file))?.mtime
  }

  async listDirectory(file: TrampFileName) {
    const prefix = file.localname.endsWith("/") ? file.localname : `${file.localname}/`
    const keyPrefix = `${file.user ?? ""}@${file.host}:${file.port ?? ""}:`
    return [...this.files.entries()]
      .filter(([key]) => key.startsWith(`${keyPrefix}${prefix}`))
      .map(([key, value]) => {
        const localname = key.slice(keyPrefix.length)
        const name = localname.slice(prefix.length)
        return {
          name,
          path: formatTrampFileName(file, localname),
          isDirectory: false,
          size: value.text.length,
          mtime: new Date(value.mtime),
        }
      })
  }

  async copyFile(from: TrampFileName, to: TrampFileName): Promise<void> {
    const source = this.files.get(this.key(from))
    if (source) this.files.set(this.key(to), { ...source })
  }
}

test("tramp parser accepts Emacs ssh file names", () => {
  const parsed = parseTrampFileName("/ssh:alice@example.com#2222:/home/alice/app.ts")
  expect(parsed).toEqual({
    method: "ssh",
    user: "alice",
    host: "example.com",
    port: 2222,
    localname: "/home/alice/app.ts",
  })
  expect(formatTrampFileName(parsed!)).toBe("/ssh:alice@example.com#2222:/home/alice/app.ts")
  expect(parseTrampFileName("/tmp/ssh:alice@example.com:/x")).toBeNull()
})

test("find-file opens ssh tramp names as remote file buffers", async () => {
  const editor = makeEditor()
  const transport = new FakeTransport()
  transport.addFile("/ssh:alice@box:/home/alice/app.ts", "export const n = 1\n", 10)
  install(editor, createPluginContext(editor), { transport })

  await editor.run("find-file", ["/Users/me/project//ssh:alice@box:/home/alice/app.ts"])

  const buffer = editor.currentBuffer
  expect(buffer.path).toBe("/ssh:alice@box:/home/alice/app.ts")
  expect(buffer.text).toBe("export const n = 1\n")
  expect(buffer.mode).toBe("typescript")
  expect(buffer.minorModes.has("tramp-mode")).toBe(true)
  expect(buffer.directory()).toBe("/ssh:alice@box:/home/alice")
  expect(editor.autoSavePath(buffer)).toBeNull()

  buffer.insert("// remote\n")
  await buffer.save({ makeBackupFiles: true })
  expect(transport.writes).toEqual(["/ssh:alice@box:/home/alice/app.ts"])
  expect(buffer.dirty).toBe(false)
  expect(await transport.readFile(parseTrampFileName(buffer.path!)!)).toContain("// remote")
})

test("remote dired entries visit tramp files through dired-find-file", async () => {
  const editor = makeEditor()
  const transport = new FakeTransport()
  transport.addDirectory("/ssh:box:/etc")
  transport.addFile("/ssh:box:/etc/hosts", "127.0.0.1 localhost\n")
  install(editor, createPluginContext(editor), { transport })

  await editor.openDirectory("/ssh:box:/etc")
  expect(editor.currentBuffer.mode).toBe("dired")
  expect(editor.currentBuffer.minorModes.has("tramp-mode")).toBe(true)
  const entry = diredEntryAtPoint(editor.currentBuffer)
  expect(entry?.path).toBe("/ssh:box:/etc/hosts")

  await editor.run("dired-find-file")
  expect(editor.currentBuffer.path).toBe("/ssh:box:/etc/hosts")
  expect(editor.currentBuffer.text).toBe("127.0.0.1 localhost\n")
})

function dirname(path: string): string {
  const i = path.lastIndexOf("/")
  if (i <= 0) return "/"
  return path.slice(0, i)
}
