/// <reference lib="dom" />
/**
 * IndexedDB-backed `Cas` for the browser shadow. Persists buffer/file content
 * across page reloads so a reconnecting S can answer `BufferRef` with `Have`
 * instead of re-streaming everything (DESIGN.md §Content-addressed).
 *
 * IndexedDB has no sync read path, so `lookup` is a constant miss and the real
 * work happens in `lookupAsync`. `write` computes the sha synchronously
 * (crypto-shim's `createHash`) and fire-and-forgets the `put` — every caller
 * only needs the sha back, not durability.
 */

import type { Cas } from "../shadow/cas"
import { sha256 } from "../shadow/cas"

type Entry = { sha: string; text: string; atime: number }

const DB_NAME = "jemacs-cas"
const STORE = "blobs"

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"))
  })
}

export class IdbCas implements Cas {
  private db: Promise<IDBDatabase> | undefined

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db
    this.db = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1)
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) {
          r.result.createObjectStore(STORE, { keyPath: "sha" })
        }
      }
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error ?? new Error("IndexedDB open failed"))
    })
    return this.db
  }

  /** Sync lookup is always a miss — callers use `lookupAsync`. */
  lookup(_sha: string): string | undefined {
    return undefined
  }

  async lookupAsync(sha: string): Promise<string | undefined> {
    const db = await this.open()
    const store = db.transaction(STORE, "readonly").objectStore(STORE)
    const entry = (await req(store.get(sha))) as Entry | undefined
    if (entry === undefined) return undefined
    // Touch atime so eviction keeps recently-read entries.
    void this.put({ ...entry, atime: Date.now() })
    return entry.text
  }

  write(text: string): string {
    const sha = sha256(text)
    void this.put({ sha, text, atime: Date.now() })
    return sha
  }

  private async put(entry: Entry): Promise<void> {
    try {
      const db = await this.open()
      const store = db.transaction(STORE, "readwrite").objectStore(STORE)
      await req(store.put(entry))
    } catch {
      // Quota / private-mode failures degrade to MemCas-equivalent behaviour:
      // sha is still correct, S just re-Wants on next reload.
    }
  }

  /** Snapshot of all entries for `evictCas`-style LRU. */
  async entriesAsync(): Promise<Array<{ sha: string; size: number; atime: number }>> {
    const db = await this.open()
    const store = db.transaction(STORE, "readonly").objectStore(STORE)
    const out: Array<{ sha: string; size: number; atime: number }> = []
    return new Promise((resolve, reject) => {
      const r = store.openCursor()
      r.onsuccess = () => {
        const cursor = r.result
        if (!cursor) return resolve(out)
        const e = cursor.value as Entry
        out.push({ sha: e.sha, size: e.text.length, atime: e.atime })
        cursor.continue()
      }
      r.onerror = () => reject(r.error ?? new Error("IndexedDB cursor failed"))
    })
  }

  async delete(sha: string): Promise<void> {
    const db = await this.open()
    const store = db.transaction(STORE, "readwrite").objectStore(STORE)
    await req(store.delete(sha))
  }
}
