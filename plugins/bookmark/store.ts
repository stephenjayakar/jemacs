import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { getCustom } from "../../src/runtime/custom"

export type BookmarkRecord = {
  filename: string
  position: number
  frontContext?: string
  rearContext?: string
  annotation?: string
}

export type BookmarkTable = Record<string, BookmarkRecord>

export function bookmarkFile(): string {
  return getCustom<string>("bookmark-file") ?? join(homedir(), ".jemacs", "bookmarks.json")
}

export async function bookmarkSaveToFile(table: BookmarkTable, file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(table, null, 2) + "\n", "utf8")
}

export async function bookmarkSave(table: BookmarkTable): Promise<void> {
  await bookmarkSaveToFile(table, bookmarkFile())
}

export async function bookmarkLoadFromFile(file: string): Promise<BookmarkTable> {
  const text = await readFile(file, "utf8").catch(() => null)
  if (!text) return {}
  try {
    const data = JSON.parse(text) as BookmarkTable
    if (!data || typeof data !== "object" || Array.isArray(data)) return {}
    return data
  } catch {
    return {}
  }
}

export async function bookmarkLoad(): Promise<BookmarkTable> {
  return bookmarkLoadFromFile(bookmarkFile())
}

export function bookmarkNames(table: BookmarkTable): string[] {
  return Object.keys(table).sort((a, b) => a.localeCompare(b))
}
