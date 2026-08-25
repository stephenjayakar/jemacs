import { resolve } from "node:path"
import type { Editor } from "../../src/kernel/editor"
import { BufferModel, REVERT_BUFFER_FUNCTION_KEY } from "../../src/kernel/buffer"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defineMode, type WebSurfaceModel } from "../../src/modes/mode"
import { Keymap } from "../../src/kernel/keymap"
import { stat } from "../../src/platform/runtime"

/**
 * `image-mode`: view a picture file in the GUI.
 *
 * Emacs holds the raw bytes in the buffer and draws them with a display property. This
 * mode keeps the bytes out of the buffer: the kernel reads files as UTF-8, so a PNG in
 * `buffer.text` is both lossy and large. The buffer holds a short description instead,
 * and the picture reaches the GUI as a `webSurface` `image` node that names the file.
 *
 * The TUI has no DOM, so it shows the description, exactly as it does for every other
 * web surface.
 */

/** Absolute path of the picture this buffer shows. */
const IMAGE_PATH = "image-file-path"
/** Size of that file in bytes, as read at visit time. */
const IMAGE_SIZE = "image-file-size"

/** Formats jemacs renders as pictures. */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.test(path)
}

/**
 * A TRAMP-style remote name, which this mode must not claim.
 *
 * `tramp` wraps `editor.openFile` too, and this plugin loads after it, so this wrapper
 * runs first and has to hand remote names back.
 */
function isRemoteName(path: string): boolean {
  return /^\/[^/]+:/.test(path)
}

/** `file:` URL for an absolute path, with each segment escaped. */
export function fileUrl(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`
  return `${(size / 1024 / 1024).toFixed(1)} MiB`
}

/** Body text for an image buffer. This is what the terminal shows. */
export function imageBufferText(path: string, size: number): string {
  const name = path.split("/").pop() ?? path
  return `${name}\n${path}\n${formatBytes(size)}\n\nOpen this file in the GUI to see the picture.\n`
}

/** The GUI surface: the file name, then the picture itself. */
export function imageSurface(path: string, size: number): WebSurfaceModel {
  const name = path.split("/").pop() ?? path
  return {
    kind: "web",
    nodes: [
      { kind: "text", face: "shadow", text: `${name} — ${formatBytes(size)}` },
      { kind: "image", src: fileUrl(path), title: path },
    ],
  }
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const keymap = new Keymap("image-mode-map")
  keymap.bind("q", "quit-window")
  keymap.bind("g", "revert-buffer")

  defineMode({
    name: "image-mode",
    parent: "text",
    keymap,
    webSurface: buffer => {
      const path = buffer.locals.get(IMAGE_PATH)
      if (typeof path !== "string") return null
      const size = buffer.locals.get(IMAGE_SIZE)
      return imageSurface(path, typeof size === "number" ? size : 0)
    },
  })

  const previousOpenFile = editor.openFile.bind(editor)

  editor.openFile = async (path, options = {}) => {
    if (options.literally || isRemoteName(path) || !isImagePath(path)) {
      return previousOpenFile(path, options)
    }
    return openImageFile(editor, path)
  }

  ctx.onDispose(() => {
    editor.openFile = previousOpenFile
  })

  ctx.command("image-mode", async ({ editor, buffer }) => {
    const path = buffer.path
    if (!path) {
      editor.message("Current buffer is not visiting a file")
      return
    }
    await enterImageMode(editor, buffer, path)
  }, "Show the file this buffer visits as a picture (GUI only).")

  ctx.command("image-revert", async ({ editor, buffer }) => {
    const path = buffer.locals.get(IMAGE_PATH)
    if (typeof path !== "string") return
    await enterImageMode(editor, buffer, path)
    editor.message(`Reverted ${editor.bufferDisplayName(buffer)}`)
  }, "Re-read the picture this buffer shows.")
}

/** Visit `path` as a picture, without reading its bytes into the buffer. */
async function openImageFile(editor: Editor, input: string): Promise<BufferModel> {
  // `visitPath` matches buffers by exact path, so resolve first, as `openFile` does.
  const path = resolve(input)
  const buffer = await editor.visitPath(path, async full => {
    const name = full.split("/").pop() ?? full
    const created = new BufferModel({ name, path: full, text: "", kind: "file", mode: "image-mode" })
    created.readOnly = true
    return created
  }, "image-mode", { skipLsp: true })
  await enterImageMode(editor, buffer, path)
  editor.message(`Opened ${path}`)
  return buffer
}

/** Fill in the description text and the locals the surface reads. */
async function enterImageMode(editor: Editor, buffer: BufferModel, path: string): Promise<void> {
  const size = (await stat(path))?.size ?? 0
  buffer.locals.set(IMAGE_PATH, path)
  buffer.locals.set(IMAGE_SIZE, size)
  // `revert-buffer` re-reads the file as UTF-8, which would replace the description with
  // mangled PNG bytes. Emacs dispatches through this local first, so `g` rebuilds the
  // description and re-reads the size instead.
  buffer.locals.set(REVERT_BUFFER_FUNCTION_KEY, "image-revert")
  // `markDirty: false` keeps this a programmatic write, so `assertWritable` allows it on
  // a read-only buffer and the buffer never looks modified.
  buffer.setText(imageBufferText(path, size), false)
  buffer.readOnly = true
  buffer.dirty = false
  editor.enterMode(buffer, "image-mode")
  await editor.changed("image-mode")
}
