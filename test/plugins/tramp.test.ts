import { test, expect } from "bun:test"
import { makeEditor } from "./helper"
import { createPluginContext } from "../../src/runtime/plugin-context"
import { diredCreateDirectory, diredDoDelete, diredDoRename, diredEntryAtPoint } from "../../src/modes/dired"
import { buildSshArgv, install, parseTrampFileName, formatTrampFileName, type RemoteTransport, type TrampFileName } from "../../plugins/tramp"

class FakeTransport implements RemoteTransport {
  files = new Map<string, { text: string; mtime: number }>()
  directories = new Set<string>()
  writes: string[] = []

  key(file: TrampFileName): string {
    return `${file.method}:${file.user ?? ""}@${file.host ?? ""}:${file.port ?? ""}:${file.localname}`
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
    const keyPrefix = `${file.method}:${file.user ?? ""}@${file.host ?? ""}:${file.port ?? ""}:`
    const entries = [
      ...[...this.directories]
        .filter(key => key.startsWith(`${keyPrefix}${prefix}`))
        .map(key => {
          const localname = key.slice(keyPrefix.length)
          const name = localname.slice(prefix.length)
          if (!name || name.includes("/")) return null
          return {
            name,
            path: formatTrampFileName(file, localname),
            isDirectory: true,
            size: 0,
            mtime: new Date(1_000),
          }
        }),
      ...[...this.files.entries()]
      .filter(([key]) => key.startsWith(`${keyPrefix}${prefix}`))
      .map(([key, value]) => {
        const localname = key.slice(keyPrefix.length)
        const name = localname.slice(prefix.length)
        if (!name || name.includes("/")) return null
        return {
          name,
          path: formatTrampFileName(file, localname),
          isDirectory: false,
          size: value.text.length,
          mtime: new Date(value.mtime),
        }
      }),
    ]
    return entries.filter(entry => entry != null).sort((a, b) => a.name.localeCompare(b.name))
  }

  async copyFile(from: TrampFileName, to: TrampFileName, recursive = false): Promise<void> {
    const source = this.files.get(this.key(from))
    if (source) {
      this.files.set(this.key(to), { ...source })
      this.addDirectory(formatTrampFileName(to, dirname(to.localname)))
      return
    }
    if (!recursive || !this.directories.has(this.key(from))) return
    this.addDirectory(formatTrampFileName(to))
    const fromPrefix = `${this.key(from)}/`
    const toPrefix = `${this.key(to)}/`
    for (const dir of [...this.directories]) {
      if (dir.startsWith(fromPrefix)) this.directories.add(`${toPrefix}${dir.slice(fromPrefix.length)}`)
    }
    for (const [key, value] of [...this.files]) {
      if (key.startsWith(fromPrefix)) this.files.set(`${toPrefix}${key.slice(fromPrefix.length)}`, { ...value })
    }
  }

  async deleteFile(file: TrampFileName, recursive = false): Promise<void> {
    const key = this.key(file)
    this.files.delete(key)
    this.directories.delete(key)
    if (!recursive) return
    const prefix = `${key}/`
    for (const child of [...this.files.keys()]) {
      if (child.startsWith(prefix)) this.files.delete(child)
    }
    for (const child of [...this.directories]) {
      if (child.startsWith(prefix)) this.directories.delete(child)
    }
  }

  async rename(from: TrampFileName, to: TrampFileName): Promise<void> {
    const fromKey = this.key(from)
    const toKey = this.key(to)
    const file = this.files.get(fromKey)
    if (file) {
      this.files.delete(fromKey)
      this.files.set(toKey, file)
      this.addDirectory(formatTrampFileName(to, dirname(to.localname)))
      return
    }
    if (!this.directories.has(fromKey)) return
    this.directories.delete(fromKey)
    this.directories.add(toKey)
    const fromPrefix = `${fromKey}/`
    const toPrefix = `${toKey}/`
    for (const dir of [...this.directories]) {
      if (dir.startsWith(fromPrefix)) {
        this.directories.delete(dir)
        this.directories.add(`${toPrefix}${dir.slice(fromPrefix.length)}`)
      }
    }
    for (const [key, value] of [...this.files]) {
      if (key.startsWith(fromPrefix)) {
        this.files.delete(key)
        this.files.set(`${toPrefix}${key.slice(fromPrefix.length)}`, value)
      }
    }
  }

  async mkdir(file: TrampFileName): Promise<void> {
    this.addDirectory(formatTrampFileName(file))
  }

  async touch(file: TrampFileName): Promise<void> {
    const key = this.key(file)
    const existing = this.files.get(key)
    this.files.set(key, { text: existing?.text ?? "", mtime: Date.now() })
    this.addDirectory(formatTrampFileName(file, dirname(file.localname)))
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

test("tramp parser accepts Emacs sudo file names", () => {
  const parsed = parseTrampFileName("/sudo::/etc/hosts")
  expect(parsed).toEqual({
    method: "sudo",
    localname: "/etc/hosts",
  })
  expect(formatTrampFileName(parsed!)).toBe("/sudo::/etc/hosts")
})

test("buildSshArgv includes noninteractive connection reuse options", () => {
  const file = parseTrampFileName("/ssh:alice@example.com#2222:/home/alice/app.ts")!
  expect(buildSshArgv(file, "printf ok", "/home/alice/.ssh")).toEqual([
    "ssh",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=auto",
    "-o", "ControlPersist=60",
    "-o", "ControlPath=/home/alice/.ssh/jemacs-%r@%h-%p",
    "-p", "2222",
    "--",
    "alice@example.com",
    "printf ok",
  ])
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

test("openTrampFile failure rethrows a tramp-prefixed error after announcing", async () => {
  const editor = makeEditor()
  const messages: string[] = []
  editor.events.on("message", ({ text }) => { if (text) messages.push(text) })
  const transport = new FakeTransport()
  transport.fileKind = async () => { throw new Error("ssh failed (is key-based auth set up for this host?): Permission denied (publickey).") }
  install(editor, createPluginContext(editor), { transport })

  // Rethrown (not swallowed) so find-file's "Opened ..." success message never
  // prints; the command runner surfaces the message exactly once.
  await expect(editor.openFile("/ssh:alice@box:/home/alice/app.ts")).rejects.toThrow(
    "tramp: ssh failed (is key-based auth set up for this host?): Permission denied (publickey).",
  )
  expect(messages).toContain("tramp: connecting to box...")
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

test("remote dired creates, renames, and deletes through tramp transport", async () => {
  const editor = makeEditor()
  const transport = new FakeTransport()
  transport.addDirectory("/ssh:box:/etc")
  transport.addFile("/ssh:box:/etc/hosts", "127.0.0.1 localhost\n")
  install(editor, createPluginContext(editor), { transport })

  const buffer = await editor.openDirectory("/ssh:box:/etc")

  await diredCreateDirectory(editor, buffer, "conf.d")
  expect(await transport.fileKind(parseTrampFileName("/ssh:box:/etc/conf.d")!)).toBe("directory")
  expect(buffer.text).toContain("conf.d")

  buffer.point = buffer.text.indexOf("hosts")
  const renamePrompt = diredDoRename(editor, buffer, null)
  editor.activeBuffer.setText("hosts.new", true)
  editor.activeBuffer.point = "hosts.new".length
  await editor.handleKey({ name: "return" })
  await renamePrompt
  expect(await transport.fileKind(parseTrampFileName("/ssh:box:/etc/hosts")!)).toBe("missing")
  expect(await transport.readFile(parseTrampFileName("/ssh:box:/etc/hosts.new")!)).toBe("127.0.0.1 localhost\n")
  expect(buffer.text).toContain("hosts.new")

  buffer.point = buffer.text.indexOf("hosts.new")
  const deletePrompt = diredDoDelete(editor, buffer, null)
  editor.activeBuffer.setText("yes", true)
  await editor.handleKey({ name: "return" })
  await deletePrompt
  expect(await transport.fileKind(parseTrampFileName("/ssh:box:/etc/hosts.new")!)).toBe("missing")
  expect(buffer.text).not.toContain("hosts.new")
})

function dirname(path: string): string {
  const i = path.lastIndexOf("/")
  if (i <= 0) return "/"
  return path.slice(0, i)
}
