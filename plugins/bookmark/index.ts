import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { defaultEmacsBookmarkFile, parseEmacsBookmarkFile } from "./emacs-import"
import {
  bookmarkFile,
  bookmarkLoad,
  bookmarkNames,
  bookmarkSave,
  bookmarkSaveToFile,
  type BookmarkRecord,
  type BookmarkTable,
} from "./store"

const tables = new WeakMap<Editor, BookmarkTable>()

function tableFor(editor: Editor): BookmarkTable {
  let t = tables.get(editor)
  if (!t) {
    t = {}
    tables.set(editor, t)
  }
  return t
}

function contextAround(buffer: BufferModel, point: number): { front?: string; rear?: string } {
  const front = buffer.text.slice(Math.max(0, point - 16), point)
  const rear = buffer.text.slice(point, Math.min(buffer.text.length, point + 16))
  return { front: front || undefined, rear: rear || undefined }
}

function bookmarkLocation(buffer: BufferModel): { filename: string; position: number } | null {
  if (buffer.path) {
    const filename = buffer.kind === "directory"
      ? (buffer.path.endsWith("/") ? buffer.path : `${buffer.path}/`)
      : buffer.path
    return { filename, position: buffer.point }
  }
  return null
}

function defaultBookmarkName(buffer: BufferModel): string {
  if (buffer.path) return basename(buffer.path.replace(/\/$/, "")) || buffer.name
  return buffer.name.replace(/^\*/, "").replace(/\*$/, "") || "bookmark"
}

function uniqueName(table: BookmarkTable, base: string): string {
  if (!(base in table)) return base
  let n = 2
  while (`${base}<${n}>` in table) n++
  return `${base}<${n}>`
}

function isRemotePath(path: string): boolean {
  return /^\/[^:]+:/.test(path) || /^[a-z+]+:\/\//i.test(path)
}

async function jumpToBookmark(
  editor: Editor,
  record: BookmarkRecord,
  name: string,
  options: { otherWindow?: boolean } = {},
): Promise<void> {
  if (isRemotePath(record.filename)) {
    editor.message(`Bookmark ${name}: remote paths (${record.filename}) are not supported yet`)
    return
  }
  if (options.otherWindow) editor.ensureOtherWindowSelected()
  const buffer = await editor.openFile(record.filename)
  const pos = Math.min(Math.max(0, record.position), buffer.text.length)
  buffer.point = pos
  editor.message(`Jumped to bookmark ${name}`)
}

export async function bookmarkImportFromEmacs(
  editor: Editor,
  source = getCustom<string>("bookmark-emacs-file") ?? defaultEmacsBookmarkFile(),
  merge = true,
): Promise<number> {
  const text = await readFile(source, "utf8").catch(() => null)
  if (!text) {
    editor.message(`No Emacs bookmark file at ${source}`)
    return 0
  }
  const imported = parseEmacsBookmarkFile(text)
  const table = tableFor(editor)
  let count = 0
  for (const [name, record] of Object.entries(imported)) {
    if (!merge && name in table) continue
    table[name] = record
    count++
  }
  await bookmarkSave(table)
  return count
}

export async function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): Promise<void> {
  defcustom("bookmark-file", "string", join(homedir(), ".jemacs", "bookmarks.json"),
    "File where bookmarks are persisted.")
  defcustom("bookmark-emacs-file", "string", defaultEmacsBookmarkFile(),
    "Emacs bookmark file to import from (bookmark-import-from-emacs).")

  ctx.minorMode({ name: "bookmark-mode", global: true, lighter: "" })

  const loaded = await bookmarkLoad()
  Object.assign(tableFor(editor), loaded)
  editor.enableMinorMode("bookmark-mode")

  ctx.hook("kill-emacs-hook", async ({ editor }) => {
    if (editor.globalMinorModes.has("bookmark-mode")) await bookmarkSave(tableFor(editor))
  })

  editor.command("bookmark-set", async ({ buffer, editor, args }) => {
    const loc = bookmarkLocation(buffer)
    if (!loc) {
      editor.message("Cannot set bookmark in a buffer without a file name")
      return
    }
    const table = tableFor(editor)
    const suggested = args[0] ?? defaultBookmarkName(buffer)
    const name = args[0]
      ?? await editor.completingRead("Set bookmark: ", {
        collection: bookmarkNames(table),
        history: "bookmark",
        initialValue: suggested,
      })
    if (!name) return
    const ctxAround = contextAround(buffer, buffer.point)
    table[name] = {
      filename: loc.filename,
      position: loc.position,
      frontContext: ctxAround.front,
      rearContext: ctxAround.rear,
    }
    await bookmarkSave(table)
    editor.message(`Set bookmark ${name}`)
  }, "Record the current location in the bookmark list.")

  editor.command("bookmark-jump", async ({ editor, args }) => {
    const table = tableFor(editor)
    const names = bookmarkNames(table)
    if (!names.length) {
      editor.message("No bookmarks")
      return
    }
    const name = args[0]
      ?? await editor.completingRead("Jump to bookmark: ", {
        collection: names,
        history: "bookmark",
      })
    if (!name) return
    const record = table[name]
    if (!record) {
      editor.message(`No bookmark named ${name}`)
      return
    }
    await jumpToBookmark(editor, record, name)
  }, "Jump to a previously set bookmark.")

  editor.command("bookmark-jump-other-window", async ({ editor, args }) => {
    const table = tableFor(editor)
    const names = bookmarkNames(table)
    if (!names.length) {
      editor.message("No bookmarks")
      return
    }
    const name = args[0]
      ?? await editor.completingRead("Jump to bookmark: ", {
        collection: names,
        history: "bookmark",
      })
    if (!name) return
    const record = table[name]
    if (!record) {
      editor.message(`No bookmark named ${name}`)
      return
    }
    await jumpToBookmark(editor, record, name, { otherWindow: true })
  }, "Jump to BOOKMARK in another window.")

  editor.command("bookmark-rename", async ({ editor, args }) => {
    const table = tableFor(editor)
    const names = bookmarkNames(table)
    if (!names.length) {
      editor.message("No bookmarks")
      return
    }
    const oldName = args[0]
      ?? await editor.completingRead("Rename bookmark: ", {
        collection: names,
        history: "bookmark",
      })
    if (!oldName) return
    const record = table[oldName]
    if (!record) {
      editor.message(`No bookmark named ${oldName}`)
      return
    }
    const newName = args[1]
      ?? await editor.completingRead(`Rename ${oldName} to: `, {
        collection: names,
        history: "bookmark",
        initialValue: oldName,
      })
    if (!newName || newName === oldName) return
    if (newName in table) {
      editor.message(`Bookmark ${newName} already exists`)
      return
    }
    table[newName] = record
    delete table[oldName]
    await bookmarkSave(table)
    editor.message(`Renamed bookmark ${oldName} to ${newName}`)
  }, "Change the name of OLD-NAME bookmark to NEW-NAME name.")

  editor.command("bookmark-insert-location", async ({ buffer, editor, args }) => {
    const table = tableFor(editor)
    const names = bookmarkNames(table)
    if (!names.length) {
      editor.message("No bookmarks")
      return
    }
    const name = args[0]
      ?? await editor.completingRead("Insert bookmark location: ", {
        collection: names,
        history: "bookmark",
      })
    if (!name) return
    const record = table[name]
    if (!record) {
      editor.message(`No bookmark named ${name}`)
      return
    }
    buffer.insert(record.filename)
  }, "Insert the name of the file associated with BOOKMARK-NAME.")

  const listBookmarks = ({ editor }: { editor: Editor }) => {
    const table = tableFor(editor)
    const names = bookmarkNames(table)
    if (!names.length) {
      editor.message("No bookmarks")
      return
    }
    const lines = names.map((name, i) => {
      const rec = table[name]!
      return `${String(i + 1).padStart(3)}  ${name} — ${rec.filename}${rec.position ? ` @${rec.position + 1}` : ""}`
    })
    editor.scratch("*Bookmarks*", lines.join("\n"), "text")
  }
  editor.command("bookmark-bmenu-list", listBookmarks, "Display a list of all bookmarks.")
  editor.command("list-bookmarks", listBookmarks, "Display a list of all bookmarks.")
  editor.command("bookmark-list", listBookmarks, "Compatibility alias for bookmark-bmenu-list.")

  editor.command("bookmark-delete", async ({ editor, args }) => {
    const table = tableFor(editor)
    const names = bookmarkNames(table)
    if (!names.length) {
      editor.message("No bookmarks")
      return
    }
    const name = args[0]
      ?? await editor.completingRead("Delete bookmark: ", {
        collection: names,
        history: "bookmark",
      })
    if (!name) return
    if (!(name in table)) {
      editor.message(`No bookmark named ${name}`)
      return
    }
    delete table[name]
    await bookmarkSave(table)
    editor.message(`Deleted bookmark ${name}`)
  }, "Delete a bookmark.")

  editor.command("bookmark-save", async ({ editor }) => {
    await bookmarkSave(tableFor(editor))
    editor.message(`Wrote ${bookmarkFile()}`)
  }, "Save the bookmark list to bookmark-file.")

  editor.command("bookmark-write", async ({ editor, args }) => {
    const file = args[0] ?? await editor.completingRead("Write bookmarks to file: ", {
      completion: "file",
      history: "file",
      initialValue: bookmarkFile(),
    })
    if (!file) return
    await bookmarkSaveToFile(tableFor(editor), file)
    editor.message(`Wrote ${file}`)
  }, "Write bookmarks to a file.")

  editor.command("bookmark-load", async ({ editor }) => {
    const loaded = await bookmarkLoad()
    const table = tableFor(editor)
    for (const key of Object.keys(table)) delete table[key]
    Object.assign(table, loaded)
    editor.message(`Loaded ${bookmarkNames(table).length} bookmark(s) from ${bookmarkFile()}`)
  }, "Reload bookmarks from bookmark-file.")

  editor.command("bookmark-import-from-emacs", async ({ editor, args }) => {
    const source = (args[0] as string | undefined) ?? getCustom<string>("bookmark-emacs-file") ?? defaultEmacsBookmarkFile()
    const count = await bookmarkImportFromEmacs(editor, source, true)
    editor.message(count ? `Imported ${count} bookmark(s) from ${source}` : `No bookmarks imported from ${source}`)
  }, "Import bookmarks from an Emacs bookmark file.")

  editor.key("C-x r m", "bookmark-set")
  editor.key("C-x r b", "bookmark-jump")
  editor.key("C-x r l", "bookmark-bmenu-list")
  editor.key("C-x r d", "bookmark-delete")
}
