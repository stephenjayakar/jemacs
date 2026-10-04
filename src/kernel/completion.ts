import { join, resolve } from "node:path"
import {
  cwd,
  homedir,
  isDirectory,
  onPlatformRuntimeChange,
  onPlatformRuntimeMutation,
  readdir,
  readdirTypes,
  stat,
} from "../platform/runtime"
import { getCustom } from "../runtime/custom"

const REMOTE_FILE_RE = /^\/(?:ssh|scp|sudo):/

/** Default wait before find-file shows what it has and lets the listing finish in the background. */
export const FILE_COMPLETION_TIMEOUT_DEFAULT = 120
/** Default lifetime of a cached directory listing. */
export const FILE_COMPLETION_CACHE_TTL_DEFAULT = 10_000
/** Directories kept in the listing cache. Oldest entries go first. */
const CACHE_LIMIT = 256

export function expandUserPath(input: string): string {
  if (input.startsWith("~/")) return join(homedir(), input.slice(2))
  if (input === "~") return homedir()
  return input
}

export function splitCompletionInput(input: string, baseDirectory = cwd()): { directory: string; prefix: string } {
  const expanded = expandUserPath(input)
  const lastSlash = expanded.lastIndexOf("/")
  if (lastSlash === -1) {
    return { directory: baseDirectory, prefix: expanded }
  }
  const directory = expanded.slice(0, lastSlash + 1) || "/"
  const prefix = expanded.slice(lastSlash + 1)
  return { directory, prefix }
}

/** One directory listing. `flags` says which names are directories; a name is absent while unknown. */
type DirListing = {
  names: string[]
  flags: Map<string, boolean>
}

/** Parallel stat requests allowed per directory. A slow link chokes on more. */
const STAT_CONCURRENCY = 32

type CacheEntry = {
  /** Last completed listing, or null until the first one lands. */
  listing: DirListing | null
  /** Completion time of `listing`, or 0 while none exists. */
  time: number
  /** Listing in flight, so a later keystroke joins it instead of starting a second one. */
  inFlight: Promise<DirListing> | null
}

const cache = new Map<string, CacheEntry>()

export type FileCompletionResult = {
  candidates: string[]
  /** True when the listing did not finish inside the time budget, so `candidates` may be short. */
  pending: boolean
  /** Resolves when the outstanding work finishes. Callers re-query then. Null when nothing is pending. */
  settled: Promise<unknown> | null
}

export type FileCompletionOptions = {
  /** Milliseconds to wait. 0 returns cached data only. Infinity waits for the filesystem. */
  timeoutMs?: number
}

/** Drop every cached listing. Call after a command changes the filesystem. */
export function clearFileCompletionCache(): void {
  cache.clear()
}

// A new runtime is a different filesystem (browser shadow, tests), so its listings are wrong here.
onPlatformRuntimeChange(clearFileCompletionCache)

// A write changes what the parent directory contains, so that one listing is stale.
onPlatformRuntimeMutation(path => {
  const slash = path.lastIndexOf("/")
  const parent = slash <= 0 ? "/" : path.slice(0, slash)
  cache.delete(parent)
  cache.delete(path.replace(/\/+$/, "") || "/")
})

function configuredTimeout(): number {
  const value = getCustom<number>("file-completion-timeout")
  return typeof value === "number" && value >= 0 ? value : FILE_COMPLETION_TIMEOUT_DEFAULT
}

function configuredTtl(): number {
  const value = getCustom<number>("file-completion-cache-ttl")
  return typeof value === "number" && value >= 0 ? value : FILE_COMPLETION_CACHE_TTL_DEFAULT
}

const TIMED_OUT = Symbol("timed-out")

/**
 * Resolve `promise`, or `TIMED_OUT` after `ms`.
 *
 * The work continues after a timeout: it writes into the cache, so the next query is instant.
 * A rejection also yields `TIMED_OUT`; every caller here attaches its own catch.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (!Number.isFinite(ms)) return promise.catch(() => TIMED_OUT as typeof TIMED_OUT)
  if (ms <= 0) return Promise.resolve(TIMED_OUT)
  return new Promise(resolvePromise => {
    const timer = setTimeout(() => resolvePromise(TIMED_OUT), ms)
    promise.then(
      value => { clearTimeout(timer); resolvePromise(value) },
      () => { clearTimeout(timer); resolvePromise(TIMED_OUT) },
    )
  })
}

/**
 * Read `dirPath` in one call when the runtime reports entry types.
 *
 * `readdirTypes` costs one syscall for the whole directory, while `stat` costs one round trip per
 * entry. On a network mount (NFS, SMB, sshfs) that difference is seconds. Symlinks still need a
 * `stat` each, because the directory bit of a symlink describes the link, not its target.
 */
async function readDirectoryListing(dirPath: string): Promise<DirListing> {
  const typed = await readdirTypes(dirPath).catch(() => null)
  if (typed) {
    const flags = new Map<string, boolean>()
    for (const entry of typed) {
      if (entry.directory !== null) flags.set(entry.name, entry.directory)
    }
    return { names: typed.map(entry => entry.name), flags }
  }
  const names = await readdir(dirPath).catch(() => [])
  const flags = new Map<string, boolean>()
  // No entry types, so every name needs its own stat. Do them here, as part of the background
  // listing, so the cached entry is complete and later keystrokes never pay for them.
  await statAllNames(dirPath, names, flags)
  return { names, flags }
}

/** Stat every name into `flags`, at most STAT_CONCURRENCY at a time so a big directory does not
 *  open thousands of parallel requests on one link. */
async function statAllNames(dirPath: string, names: string[], flags: Map<string, boolean>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(STAT_CONCURRENCY, names.length) }, async () => {
    while (next < names.length) {
      const name = names[next++]!
      const st = await stat(join(dirPath, name)).catch(() => null)
      flags.set(name, !!st && isDirectory(st))
    }
  })
  await Promise.all(workers)
}

/**
 * Get the listing of `dirPath`, waiting at most `budget` ms.
 *
 * A second keystroke inside the same directory joins the listing already in flight instead of
 * starting another one. It still waits out its own budget, so a fast directory answers on the
 * first keystroke; only a listing that overruns the budget falls back to the stale entry.
 */
async function acquireListing(
  dirPath: string,
  budget: number,
): Promise<{ listing: DirListing | null; pending: boolean; settled: Promise<unknown> | null }> {
  const hit = cache.get(dirPath)
  if (hit?.listing && Date.now() - hit.time < configuredTtl()) {
    return { listing: hit.listing, pending: false, settled: null }
  }
  if (hit?.inFlight) {
    const joined = await withTimeout(hit.inFlight, budget)
    if (joined === TIMED_OUT) return { listing: hit.listing, pending: true, settled: hit.inFlight }
    return { listing: joined, pending: false, settled: null }
  }
  const inFlight = readDirectoryListing(dirPath)
  const entry: CacheEntry = { listing: hit?.listing ?? null, time: hit?.time ?? 0, inFlight }
  cache.delete(dirPath)
  cache.set(dirPath, entry)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
  void inFlight.then(
    listing => { entry.listing = listing; entry.time = Date.now(); entry.inFlight = null },
    () => { entry.inFlight = null },
  )
  const result = await withTimeout(inFlight, budget)
  if (result === TIMED_OUT) return { listing: entry.listing, pending: true, settled: inFlight }
  return { listing: result, pending: false, settled: null }
}

/**
 * Mark directories among `names`, waiting at most `budget` ms.
 *
 * Runtimes without `readdirTypes` (the browser shadow) land here. A name whose flag does not arrive
 * in time comes back without a trailing slash, and `pending` tells the caller to query again.
 */
async function markDirectories(
  dirPath: string,
  names: string[],
  listing: DirListing,
  budget: number,
): Promise<{ paths: string[]; pending: boolean; settled: Promise<unknown> | null }> {
  const unknown = names.filter(name => !listing.flags.has(name))
  let pending = false
  let settled: Promise<unknown> | null = null
  if (unknown.length) {
    const work = statAllNames(dirPath, unknown, listing.flags)
    const result = await withTimeout(work, budget)
    if (result === TIMED_OUT) {
      pending = true
      settled = work
    }
  }
  const paths = names.map(name => {
    const path = join(dirPath, name)
    return listing.flags.get(name) ? `${path}/` : path
  })
  return { paths, pending, settled }
}

/**
 * Candidates for `input`, plus whether slow I/O is still outstanding.
 *
 * The time budget keeps a slow mount from stalling the key loop: the caller paints whatever the
 * cache holds, then awaits `settled` and queries again.
 */
export async function fileCompletionCandidatesBounded(
  input: string,
  baseDirectory = cwd(),
  options: FileCompletionOptions = {},
): Promise<FileCompletionResult> {
  if (REMOTE_FILE_RE.test(input)) return { candidates: [], pending: false, settled: null }
  const { directory, prefix } = splitCompletionInput(input, baseDirectory)
  const rawDir = directory.startsWith("/") ? directory : resolve(baseDirectory, directory)
  const dirPath = rawDir.replace(/\/+$/, "") || "/"
  const budget = options.timeoutMs ?? configuredTimeout()
  const started = Date.now()
  const { listing, pending, settled } = await acquireListing(dirPath, budget)
  if (!listing) return { candidates: [], pending, settled }
  const matches = completionStyleMatches(listing.names, prefix, completionStylesFor("file"))
  const remaining = Number.isFinite(budget) ? Math.max(0, budget - (Date.now() - started)) : budget
  const marked = await markDirectories(dirPath, matches, listing, remaining)
  return {
    candidates: marked.paths.sort((a, b) => a.localeCompare(b)),
    pending: pending || marked.pending,
    settled: settled ?? marked.settled,
  }
}

/**
 * `completion-styles` for CATEGORY, after `completion-category-overrides`.
 * An override entry is `[category, ["styles", ...names], ...]`, Emacs's
 * `(file (styles substring basic))`.
 */
export function completionStylesFor(category?: string): string[] {
  const overrides = getCustom<unknown>("completion-category-overrides")
  if (category && Array.isArray(overrides)) {
    for (const entry of overrides) {
      if (!Array.isArray(entry) || entry[0] !== category) continue
      const styles = entry.slice(1).find(prop => Array.isArray(prop) && prop[0] === "styles")
      if (styles) return styles.slice(1).map(String)
    }
  }
  const styles = getCustom<unknown>("completion-styles")
  return Array.isArray(styles) ? styles.map(String) : ["basic"]
}

/**
 * `completion-all-completions`: try STYLES in order and return the matches of
 * the first one that finds any. `basic`, `emacs22` and `partial-completion`
 * match a prefix; `substring` matches anywhere. Case is ignored, as
 * `read-file-name-completion-ignore-case` does on macOS.
 */
export function completionStyleMatches(candidates: readonly string[], input: string, styles: readonly string[]): string[] {
  const needle = input.toLowerCase()
  for (const style of styles) {
    let test: ((candidate: string) => boolean) | null = null
    if (style === "basic" || style === "emacs22" || style === "partial-completion") test = c => c.toLowerCase().startsWith(needle)
    else if (style === "substring") test = c => c.toLowerCase().includes(needle)
    if (!test) continue
    const matches = candidates.filter(test)
    if (matches.length) return matches
  }
  return []
}

/** Candidates for `input`. Waits for the filesystem; use `fileCompletionCandidatesBounded` on a key path. */
export async function fileCompletionCandidates(input: string, baseDirectory = cwd()): Promise<string[]> {
  const result = await fileCompletionCandidatesBounded(input, baseDirectory, { timeoutMs: Number.POSITIVE_INFINITY })
  return result.candidates
}
