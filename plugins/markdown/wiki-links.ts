/**
 * Wiki links (`[[Page]]`, `[[Page#Heading|alias]]`), as markdown-mode's
 * `markdown-follow-wiki-link-at-point` follows them, resolved the way Obsidian
 * does inside a vault.
 *
 * Inside a vault a bare name matches a note anywhere in the vault by basename
 * (case-insensitive), preferring the linking note's own folder and then the
 * shortest path; a name with a `/` is a vault path. Outside a vault the target
 * is relative to the linking file, and with
 * `markdown-wiki-link-search-subdirectories` also searched for below it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path"
import { obsidianVaultRoot } from "./paste-image"

/** `[[target#anchor|alias]]`, not preceded by `!` (an embed is shown, not followed). */
export const WIKI_LINK_RE = /(?<!!)\[\[([^\]\n|#]*)(#[^\]\n|]*)?(?:\|([^\]\n]*))?\]\]/g

export type WikiLink = {
  start: number
  end: number
  /** The page part, trimmed; `""` for a same-note link like `[[#Heading]]`. */
  target: string
  /** The anchor without its `#`: a heading, `^block-id`, or `page=N`. */
  anchor?: string
  alias?: string
}

export function wikiLinks(text: string): WikiLink[] {
  const out: WikiLink[] = []
  for (const match of text.matchAll(WIKI_LINK_RE)) {
    if (match.index == null) continue
    const target = (match[1] ?? "").trim()
    const anchor = match[2]?.slice(1).trim()
    if (!target && !anchor) continue
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      target,
      ...(anchor ? { anchor } : {}),
      ...(match[3] != null ? { alias: match[3] } : {}),
    })
  }
  return out
}

export function wikiLinkAt(text: string, point: number): WikiLink | null {
  return wikiLinks(text).find(link => point >= link.start && point < link.end) ?? null
}

/** Files Obsidian shows in its own viewer; jemacs hands these to the OS. */
const EXTERNAL_EXTENSIONS = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".heic", ".tiff",
  ".mp3", ".m4a", ".wav", ".ogg", ".flac", ".webm", ".mp4", ".mov", ".mkv",
  ".epub", ".docx", ".xlsx", ".pptx", ".zip",
])

export function wikiLinkOpensExternally(path: string): boolean {
  return EXTERNAL_EXTENSIONS.has(extname(path).toLowerCase())
}

/** `Page` names `Page.md`; a name with an extension (`deck.pdf`) may name either. */
function candidateNames(target: string): string[] {
  return target.toLowerCase().endsWith(".md") ? [target] : [target, `${target}.md`]
}

/** PATH when it is a file: a folder named like the note must not shadow `Name.md`. */
function existingFile(path: string): string | null {
  try { return statSync(path).isFile() ? path : null } catch { return null }
}

const SKIP_DIRS = new Set(["node_modules"])

/** Every file below ROOT, skipping dot-directories (`.obsidian`, `.git`, `.trash`). */
function walkFiles(root: string, out: string[] = []): string[] {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkFiles(full, out)
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(full)
    }
  }
  return out
}

/** The file below ROOT whose basename is one of NAMES, nearest to FROMDIR first. */
function searchByBasename(root: string, names: string[], fromDir: string): string | null {
  const wanted = new Set(names.map(name => basename(name).toLowerCase()))
  const hits = walkFiles(root).filter(file => wanted.has(basename(file).toLowerCase()))
  if (!hits.length) return null
  const sameDir = hits.find(file => dirname(file) === fromDir)
  if (sameDir) return sameDir
  const depth = (file: string) => relative(root, file).split(sep).length
  return hits.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0]!
}

/** Where Obsidian makes a note for a link that resolves to nothing: `newFileLocation` in app.json. */
function newNoteFolder(vault: string, fromDir: string): string {
  let app: Record<string, unknown> = {}
  try { app = JSON.parse(readFileSync(join(vault, ".obsidian", "app.json"), "utf8")) } catch { /* defaults */ }
  if (app.newFileLocation === "current") return fromDir
  if (app.newFileLocation === "folder" && typeof app.newFileFolderPath === "string") {
    return resolve(vault, app.newFileFolderPath)
  }
  return vault
}

export type WikiLinkResolution = { path: string; exists: boolean }

export type WikiLinkResolveOptions = {
  searchSubdirectories?: boolean
  /** Override vault detection (tests, or a note outside the vault tree). */
  vault?: string | null
}

/**
 * The file TARGET names from the note at FROMFILE. A target that resolves to
 * nothing yields the path a new note would get, with `exists: false`.
 */
export function resolveWikiLink(target: string, fromFile: string, options: WikiLinkResolveOptions = {}): WikiLinkResolution {
  const fromDir = dirname(resolve(fromFile))
  if (!target) return { path: resolve(fromFile), exists: true }
  const vault = options.vault !== undefined ? options.vault : obsidianVaultRoot(fromFile)
  const names = candidateNames(target)
  const newName = names.at(-1)!

  if (vault) {
    if (target.includes("/")) {
      // A vault path, or the tail of one (`Places/bar` for `Archive/Places/bar.md`).
      const relNames = candidateNames(target.replace(/^\/+/, ""))
      for (const name of relNames) {
        const hit = existingFile(join(vault, name)) ?? existingFile(join(fromDir, name))
        if (hit) return { path: hit, exists: true }
      }
      const tails = relNames.map(name => `${sep}${join(...name.split("/"))}`.toLowerCase())
      const hit = walkFiles(vault).find(file => tails.some(tail => file.toLowerCase().endsWith(tail)))
      if (hit) return { path: hit, exists: true }
      return { path: join(vault, relNames.at(-1)!), exists: false }
    }
    const hit = searchByBasename(vault, names, fromDir)
    if (hit) return { path: hit, exists: true }
    return { path: join(newNoteFolder(vault, fromDir), newName), exists: false }
  }

  for (const name of names) {
    const hit = existingFile(join(fromDir, name))
    if (hit) return { path: hit, exists: true }
  }
  if (options.searchSubdirectories) {
    const hit = searchByBasename(fromDir, names.map(name => basename(name)), fromDir)
    if (hit) return { path: hit, exists: true }
  }
  return { path: join(fromDir, newName), exists: false }
}

function slugHeading(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ")
}

/**
 * Offset of ANCHOR in TEXT: a `^block-id` at the end of a line, or a heading
 * matched case-insensitively. Obsidian nests headings as `#Parent#Child`; the
 * last segment is the one to land on.
 */
export function wikiAnchorOffset(text: string, anchor: string): number | null {
  if (anchor.startsWith("^")) {
    const re = new RegExp(`\\s\\^${anchor.slice(1).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}\\s*$`, "m")
    const match = re.exec(text)
    if (!match) return null
    return text.lastIndexOf("\n", match.index) + 1
  }
  const heading = slugHeading(anchor.split("#").filter(Boolean).at(-1) ?? anchor)
  let offset = 0
  let fence: string | null = null
  for (const line of text.split("\n")) {
    // A `# comment` inside a fenced block is code, not a heading.
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? null : marker
    } else if (!fence) {
      const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
      if (match && slugHeading(match[1] ?? "") === heading) return offset
    }
    offset += line.length + 1
  }
  return null
}
