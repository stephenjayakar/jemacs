/**
 * Pasting an image into a markdown buffer (`yank-media` for image/*).
 *
 * Inside an Obsidian vault the image goes where Obsidian would put it, by the
 * vault's `.obsidian/app.json`: `attachmentFolderPath` picks the folder,
 * `useMarkdownLinks` and `newLinkFormat` the link. Outside a vault there is no
 * rule to follow, so it asks where to save.
 */

import { existsSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import type { Editor } from "../../src/kernel/editor"
import { expandUserPath } from "../../src/kernel/completion"

export type ObsidianAttachmentSettings = {
  vault: string
  attachmentFolderPath: string
  useMarkdownLinks: boolean
  newLinkFormat: "shortest" | "relative" | "absolute"
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

/** The Obsidian vault holding FILE: the nearest ancestor with a `.obsidian` folder. */
export function obsidianVaultRoot(file: string): string | null {
  let dir = dirname(resolve(file))
  for (;;) {
    if (existsSync(join(dir, ".obsidian"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** The vault's attachment settings, with Obsidian's defaults for unset keys. */
export function obsidianAttachmentSettings(vault: string): ObsidianAttachmentSettings {
  let app: Record<string, unknown> = {}
  try {
    app = JSON.parse(readFileSync(join(vault, ".obsidian", "app.json"), "utf8"))
  } catch {
    // No app.json yet: every setting is at its default.
  }
  const format = app.newLinkFormat
  return {
    vault,
    attachmentFolderPath: typeof app.attachmentFolderPath === "string" ? app.attachmentFolderPath : "/",
    useMarkdownLinks: app.useMarkdownLinks === true,
    newLinkFormat: format === "relative" || format === "absolute" ? format : "shortest",
  }
}

/**
 * Obsidian's "Default location for new attachments": `/` is the vault root,
 * `./` the note's folder, `./sub` a subfolder of the note's folder, and any
 * other value a folder relative to the vault root.
 */
export function obsidianAttachmentFolder(settings: ObsidianAttachmentSettings, notePath: string): string {
  const setting = settings.attachmentFolderPath.trim()
  const noteDir = dirname(resolve(notePath))
  if (setting === "" || setting === "/") return settings.vault
  if (setting === "." || setting === "./") return noteDir
  if (setting.startsWith("./")) return join(noteDir, setting.slice(2))
  return join(settings.vault, setting.replace(/^\/+/, ""))
}

/** The embed Obsidian inserts for FILE in the note at NOTEPATH. */
export function obsidianEmbed(settings: ObsidianAttachmentSettings, notePath: string, file: string): string {
  // "shortest" is the bare name when it is unique in the vault. A freshly
  // pasted name carries a timestamp, so it is taken to be unique.
  const target = settings.newLinkFormat === "absolute"
    ? posix(relative(settings.vault, file))
    : settings.newLinkFormat === "relative"
      ? posix(relative(dirname(resolve(notePath)), file))
      : basename(file)
  return settings.useMarkdownLinks ? `![](${encodeURI(target)})` : `![[${target}]]`
}

/** Obsidian's paste name stamp, `moment().format("YYYYMMDDHHmmss")`. */
export function pasteTimestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** `<folder>/<name>.<ext>`, or Obsidian's `<name> 1.<ext>`, `<name> 2.<ext>`... when taken. */
export function availableAttachmentPath(folder: string, name: string, ext: string): string {
  let candidate = join(folder, `${name}.${ext}`)
  for (let i = 1; existsSync(candidate); i++) candidate = join(folder, `${name} ${i}.${ext}`)
  return candidate
}

/** The `yank-media` handler markdown modes register for image/*. */
export async function markdownYankImage(editor: Editor, mime: string, data: Uint8Array, now = new Date()): Promise<void> {
  const buffer = editor.activeBuffer
  const ext = IMAGE_EXTENSIONS[mime] ?? "png"
  const stamp = pasteTimestamp(now)
  const notePath = buffer.path
  const vault = notePath ? obsidianVaultRoot(notePath) : null
  let file: string
  let link: string
  if (notePath && vault) {
    const settings = obsidianAttachmentSettings(vault)
    file = availableAttachmentPath(obsidianAttachmentFolder(settings, notePath), `Pasted image ${stamp}`, ext)
    link = obsidianEmbed(settings, notePath, file)
  } else {
    const base = buffer.directory() ?? process.cwd()
    const answer = await editor.completingRead("Save image to: ", {
      completion: "file",
      initialValue: join(base, `pasted-image-${stamp}.${ext}`),
    })
    if (!answer) return
    file = resolve(base, expandUserPath(answer))
    const target = notePath ? posix(relative(dirname(resolve(notePath)), file)) : file
    link = `![](${encodeURI(target)})`
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, data)
  buffer.insert(link)
  editor.message(`Saved ${vault ? posix(relative(vault, file)) : file}`)
}

function posix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/")
}
