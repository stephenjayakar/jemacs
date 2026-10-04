/**
 * Inline images for markdown in a GUI text column.
 *
 * The display filter needs an image's size synchronously (it sets the row's
 * height, which wraps, scroll costs and `C-n` all read), so this reads only the
 * file header -- a few KB -- and caches the result per path.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { homedir } from "node:os"
import { pathToFileURL } from "node:url"
import { obsidianAttachmentFolder, obsidianAttachmentSettings, obsidianVaultRoot } from "./paste-image"

export type InlineImage = { src: string; width: number; height: number }

/** `![alt](path)`, `![alt](<path with spaces>)` and Obsidian `![[file.png|alt]]`. */
const IMAGE_RE = /!\[\[([^\]|\n]+?)(?:\|[^\]\n]*)?\]\]|!\[[^\]\n]*\]\((?:<([^>\n]+)>|([^)\s\n]+))(?:\s+"[^"\n]*")?\)/

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i

/** Folders Obsidian and other editors commonly use for attachments. */
const ATTACHMENT_DIRS = ["", "attachments", "assets", "images", "_attachments"]

type CacheEntry = { size: { width: number; height: number } | null; mtimeMs: number; checkedAt: number }
const sizeCache = new Map<string, CacheEntry>()
const resolveCache = new Map<string, { path: string | null; checkedAt: number }>()
/** How long a missing file stays missing before we look again (a pasted image is written after its link). */
const RETRY_MS = 2000

export type ImageMatch = { start: number; end: number; image: InlineImage }

/** The first local image link on `line` that resolves to a readable image. */
export function findInlineImage(line: string, bufferPath: string | undefined): ImageMatch | null {
  const m = IMAGE_RE.exec(line)
  if (!m || m.index == null) return null
  const target = (m[1] ?? m[2] ?? m[3] ?? "").trim()
  if (!target || /^[a-z]+:\/\//i.test(target) || !IMAGE_EXT_RE.test(target)) return null
  const path = resolveImagePath(safeDecode(target), bufferPath, m[1] != null)
  if (!path) return null
  const size = imageSize(path)
  if (!size) return null
  return { start: m.index, end: m.index + m[0].length, image: { src: pathToFileURL(path).href, ...size } }
}

function safeDecode(target: string): string {
  try { return decodeURIComponent(target) } catch { return target }
}

/**
 * Relative to the file first. A wiki embed (`![[x.png]]`) or a bare-name
 * link names a file anywhere in the vault, so it also checks attachment
 * folders in each ancestor, up to the vault root (the folder holding
 * `.obsidian`) or home, and then the vault's configured attachment folder.
 */
function resolveImagePath(target: string, bufferPath: string | undefined, wiki: boolean): string | null {
  if (isAbsolute(target)) return existsSync(target) ? target : null
  if (!bufferPath) return null
  const key = `${bufferPath}\u0000${target}\u0000${wiki}`
  const cached = resolveCache.get(key)
  const now = Date.now()
  if (cached && (cached.path || now - cached.checkedAt < RETRY_MS)) return cached.path
  let found: string | null = null
  const direct = resolve(dirname(bufferPath), target)
  if (existsSync(direct)) found = direct
  else if (wiki || !target.includes("/")) {
    const home = homedir()
    let dir = dirname(bufferPath)
    for (let depth = 0; depth < 8 && !found; depth++) {
      for (const sub of ATTACHMENT_DIRS) {
        const candidate = join(dir, sub, target)
        if (existsSync(candidate)) { found = candidate; break }
      }
      const parent = dirname(dir)
      if (existsSync(join(dir, ".obsidian")) || dir === home || parent === dir) break
      dir = parent
    }
    const vault = found ? null : obsidianVaultRoot(bufferPath)
    if (vault) {
      // `newLinkFormat: "absolute"` embeds are relative to the vault root.
      const folder = obsidianAttachmentFolder(obsidianAttachmentSettings(vault), bufferPath)
      found = [join(folder, target), join(vault, target)].find(candidate => existsSync(candidate)) ?? null
    }
  }
  resolveCache.set(key, { path: found, checkedAt: now })
  return found
}

/** Pixel size from the file header, cached until the file changes. */
export function imageSize(path: string): { width: number; height: number } | null {
  let mtimeMs = 0
  try { mtimeMs = statSync(path).mtimeMs } catch { return null }
  const cached = sizeCache.get(path)
  if (cached && cached.mtimeMs === mtimeMs && (cached.size || Date.now() - cached.checkedAt < RETRY_MS)) return cached.size
  let size: { width: number; height: number } | null = null
  try {
    const fd = openSync(path, "r")
    try {
      const buf = Buffer.alloc(64 * 1024)
      const n = readSync(fd, buf, 0, buf.length, 0)
      size = parseImageSize(buf.subarray(0, n))
    } finally {
      closeSync(fd)
    }
  } catch {
    size = null
  }
  sizeCache.set(path, { size, mtimeMs, checkedAt: Date.now() })
  return size
}

/** PNG, GIF, JPEG and WebP headers. */
export function parseImageSize(b: Uint8Array): { width: number; height: number } | null {
  const u16be = (o: number) => (b[o]! << 8) | b[o + 1]!
  const u16le = (o: number) => b[o]! | (b[o + 1]! << 8)
  const u32be = (o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!
  const u24le = (o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)
  const ok = (w: number, h: number) => (w > 0 && h > 0 ? { width: w, height: h } : null)
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ok(u32be(16), u32be(20))
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return ok(u16le(6), u16le(8))
  if (b.length >= 30 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") {
    const chunk = String.fromCharCode(...b.subarray(12, 16))
    if (chunk === "VP8 ") return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff)
    if (chunk === "VP8L") {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
      return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
    if (chunk === "VP8X") return ok(u24le(24) + 1, u24le(27) + 1)
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue }
      const marker = b[o + 1]!
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue }
      const len = u16be(o + 2)
      // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return ok(u16be(o + 7), u16be(o + 5))
      }
      o += 2 + len
    }
  }
  return null
}
