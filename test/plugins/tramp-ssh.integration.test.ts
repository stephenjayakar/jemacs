import { describe, expect, test } from "bun:test"
import { createPluginContext } from "../../src/runtime/plugin-context"
import { diredCreateDirectory } from "../../src/modes/dired"
import {
  SshRemoteTransport,
  formatTrampFileName,
  install,
  parseTrampFileName,
  type TrampFileName,
} from "../../plugins/tramp"
import { makeEditor } from "./helper"

const SKIP = process.env.JEMACS_TRAMP_SSH_INTEGRATION !== "1"
const port = Number(process.env.JEMACS_TRAMP_SSH_PORT ?? "22222")
const password = process.env.JEMACS_TRAMP_SSH_PASSWORD ?? "tramp-test"

function remote(localname: string, method: "ssh" | "scp" = "ssh"): TrampFileName {
  return {
    method,
    user: "jemacs",
    host: "127.0.0.1",
    port,
    localname,
  }
}

describe.skipIf(SKIP)("TRAMP over a real SSH filesystem", () => {
  test("reads, writes, protects, and mutates remote files through the editor", async () => {
    const prompts: Array<{ prompt: string; mask?: boolean }> = []
    const transport = new SshRemoteTransport({
      ask: async (prompt, options) => {
        prompts.push({ prompt, mask: options?.mask })
        return options?.mask ? password : "yes"
      },
    })
    const root = `/home/jemacs/workspace/integration-${process.pid}-${Date.now()}`
    const path = (name: string, method: "ssh" | "scp" = "ssh") => formatTrampFileName(remote(`${root}/${name}`, method))

    try {
      await transport.mkdir(remote(`${root}/subdir`))
      await transport.writeFile(remote(`${root}/hello apostrophe's.txt`), "remote start\n")
      await transport.writeFile(remote(`${root}/.hidden`), "hidden\n")
      await transport.writeFile(remote(`${root}/subdir/nested.txt`), "nested\n")

      const editor = makeEditor()
      install(editor, createPluginContext(editor), { transport })
      const buffer = await editor.openFile(path("hello apostrophe's.txt"))

      expect(buffer.text).toBe("remote start\n")
      expect(buffer.minorModes.has("tramp-mode")).toBe(true)
      expect(buffer.directory()).toBe(formatTrampFileName(remote(root)))
      expect(editor.autoSavePath(buffer)).toBeNull()

      buffer.append("saved through Jemacs ☃\n")
      await buffer.save({ makeBackupFiles: true })
      expect(await transport.readFile(remote(`${root}/hello apostrophe's.txt`))).toContain("saved through Jemacs")
      expect(await transport.readFile(remote(`${root}/hello apostrophe's.txt~`))).toBe("remote start\n")

      const created = await editor.openFile(path("created through editor.txt"))
      expect(created.text).toBe("")
      created.insert("new remote file\n")
      await created.save()
      expect(await transport.readFile(remote(`${root}/created through editor.txt`))).toBe("new remote file\n")

      await Bun.sleep(1_100)
      await transport.writeFile(remote(`${root}/hello apostrophe's.txt`), "external change\n")
      buffer.append("local conflict\n")
      await expect(buffer.save({ confirm: async () => false })).rejects.toThrow("changed on remote host")
      expect(await transport.readFile(remote(`${root}/hello apostrophe's.txt`))).toBe("external change\n")
      await buffer.save({ force: true })
      await transport.writeFile(remote(`${root}/hello apostrophe's.txt`), "reverted remotely\n")
      await buffer.revert()
      expect(buffer.text).toBe("reverted remotely\n")

      const directory = await editor.openDirectory(formatTrampFileName(remote(root)))
      expect(directory.text).toContain(".hidden")
      expect(directory.text).toContain("hello apostrophe's.txt")
      await diredCreateDirectory(editor, directory, "made through dired")
      expect(await transport.fileKind(remote(`${root}/made through dired`))).toBe("directory")

      await transport.copyFile(remote(`${root}/subdir`), remote(`${root}/subdir-copy`), true)
      expect(await transport.readFile(remote(`${root}/subdir-copy/nested.txt`))).toBe("nested\n")
      await transport.rename(remote(`${root}/subdir-copy/nested.txt`), remote(`${root}/subdir-copy/renamed.txt`))
      await transport.deleteFile(remote(`${root}/subdir-copy`), true)
      expect(await transport.fileKind(remote(`${root}/subdir-copy`))).toBe("missing")

      expect(await transport.readFile(parseTrampFileName(path("hello apostrophe's.txt", "scp"))!)).toBe("reverted remotely\n")
      expect(prompts.some(prompt => prompt.mask)).toBe(true)
    } finally {
      await transport.deleteFile(remote(root), true).catch(() => {})
      await transport.close()
    }
  }, 30_000)
})
