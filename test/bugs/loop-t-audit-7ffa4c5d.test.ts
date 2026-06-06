import { expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { makeEditor } from "../plugins/helper"
import { diredMarkFilesRegexp } from "../../src/modes/dired"

// t-audit-7ffa4c5d: apropos-command and dired-{mark,flag}-files-regexp build a
// RegExp directly from minibuffer input. `new RegExp("[")` throws SyntaxError,
// which propagated uncaught through editor.run — guard it and surface the
// error via editor.message instead.

test("apropos-command: invalid regex messages instead of throwing", async () => {
  const editor = makeEditor()
  let msg = ""
  editor.events.on("message", ({ text }) => { msg = text })
  await editor.run("apropos-command", ["["])
  expect(editor.currentBuffer.name).not.toBe("*Help*")
  expect(msg.toLowerCase()).toContain("invalid")
})

test("dired-{mark,flag}-files-regexp: invalid regex does not throw", async () => {
  const dir = `/tmp/jemacs-dired-regexp-${Date.now()}`
  await mkdir(dir, { recursive: true })
  await Bun.write(`${dir}/a.txt`, "x")
  try {
    const editor = makeEditor()
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })
    const buffer = await editor.openDirectory(dir)
    await editor.run("dired-mark-files-regexp", ["["])
    await editor.run("dired-flag-files-regexp", ["["])
    expect(diredMarkFilesRegexp(buffer, "[", "marked", editor)).toBe(0)
    expect(msg.toLowerCase()).toContain("invalid")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
