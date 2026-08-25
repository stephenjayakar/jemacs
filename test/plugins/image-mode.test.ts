import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { fileUrl, imageBufferText, imageSurface, install, isImagePath } from "../../plugins/image-mode"
import { modes } from "../../src/modes/mode"

/** Smallest valid PNG: a 1x1 transparent pixel. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

let dir = ""
let pngPath = ""

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jemacs-image-mode-"))
  pngPath = join(dir, "pixel.png")
  await writeFile(pngPath, Buffer.from(PNG_BASE64, "base64"))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("image-mode helpers", () => {
  test("claims the picture formats and nothing else", () => {
    for (const path of ["/a/b.png", "/a/B.JPEG", "/a/c.gif", "/a/d.webp", "/a/e.bmp"]) {
      expect(isImagePath(path)).toBe(true)
    }
    for (const path of ["/a/b.ts", "/a/pngx", "/a/b.png.ts", "/a/README.md"]) {
      expect(isImagePath(path)).toBe(false)
    }
  })

  test("escapes each path segment of the file URL", () => {
    expect(fileUrl("/tmp/my pics/a b.png")).toBe("file:///tmp/my%20pics/a%20b.png")
    // A slash stays a separator; only the segments are escaped.
    expect(fileUrl("/a/b.png")).toBe("file:///a/b.png")
  })

  test("the body text names the file and its size", () => {
    const text = imageBufferText("/tmp/pixel.png", 2048)
    expect(text).toContain("pixel.png")
    expect(text).toContain("/tmp/pixel.png")
    expect(text).toContain("2.0 KiB")
  })

  test("the surface carries one image node pointing at the file", () => {
    const surface = imageSurface("/tmp/pixel.png", 100)
    expect(surface.kind).toBe("web")
    const image = surface.nodes.find(node => node.kind === "image")
    expect(image?.src).toBe("file:///tmp/pixel.png")
    expect(image?.title).toBe("/tmp/pixel.png")
  })
})

describe("image-mode", () => {
  test("find-file on a PNG enters image-mode without reading the bytes", async () => {
    const editor = makeEditor()
    install(editor)
    await editor.run("find-file", [pngPath])

    const buffer = editor.currentBuffer
    expect(buffer.mode).toBe("image-mode")
    expect(buffer.path).toBe(pngPath)
    expect(buffer.readOnly).toBe(true)
    expect(buffer.dirty).toBe(false)
    // The buffer describes the picture; it never holds the PNG bytes.
    expect(buffer.text).toContain("pixel.png")
    expect(buffer.text).not.toContain("PNG")
  })

  test("the mode publishes a surface whose image node names the file", async () => {
    const editor = makeEditor()
    install(editor)
    await editor.run("find-file", [pngPath])

    const surface = modes.get("image-mode")!.webSurface!(editor.currentBuffer)
    expect(surface?.nodes.find(node => node.kind === "image")?.src).toBe(fileUrl(pngPath))
  })

  test("a text file still opens normally", async () => {
    const editor = makeEditor()
    install(editor)
    const textPath = join(dir, "note.txt")
    await writeFile(textPath, "hello\n")
    await editor.run("find-file", [textPath])

    expect(editor.currentBuffer.mode).not.toBe("image-mode")
    expect(editor.currentBuffer.text).toBe("hello\n")
  })

  test("dispose restores the previous openFile", async () => {
    const editor = makeEditor()
    const ctx = (await import("../../src/runtime/plugin-context")).createPluginContext(editor)
    install(editor, ctx)
    ctx.dispose()
    // The wrapper is gone, so a PNG goes back through the plain file path.
    await editor.run("find-file", [pngPath])
    expect(editor.currentBuffer.mode).not.toBe("image-mode")
  })
})

describe("image-mode revert", () => {
  test("g rebuilds the description instead of reading the bytes as text", async () => {
    const editor = makeEditor()
    install(editor)
    const path = join(dir, "grow.png")
    await writeFile(path, Buffer.from(PNG_BASE64, "base64"))
    await editor.run("find-file", [path])
    const buffer = editor.currentBuffer
    expect(buffer.text).toContain("70 B")

    // The file grows on disk; reverting must report the new size, not paste PNG bytes.
    await writeFile(path, Buffer.concat([
      Buffer.from(PNG_BASE64, "base64"),
      Buffer.alloc(4096),
    ]))
    await editor.run("revert-buffer")

    expect(editor.currentBuffer.mode).toBe("image-mode")
    expect(editor.currentBuffer.text).toContain("4.1 KiB")
    expect(editor.currentBuffer.text).not.toContain("PNG")
    expect(editor.currentBuffer.dirty).toBe(false)
  })
})
