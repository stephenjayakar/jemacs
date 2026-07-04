import type { BufferModel } from "../../src/kernel/buffer"

/** One blame chunk: a run of consecutive lines attributed to the same commit. */
export type BlameChunk = {
  sha: string
  author: string
  /** author-time, seconds since epoch. */
  time: number
  summary: string
  /** 1-indexed first line in the blamed file. */
  startLine: number
  lines: string[]
}

/** Parse `git blame --line-porcelain` output into chunks, grouping
 *  consecutive lines that belong to the same commit. */
export function parseBlamePorcelain(out: string): BlameChunk[] {
  const chunks: BlameChunk[] = []
  const meta = new Map<string, { author: string; time: number; summary: string }>()
  const lines = out.split("\n")
  let i = 0
  while (i < lines.length) {
    const header = lines[i]!
    const m = header.match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/)
    if (!m) { i++; continue }
    const sha = m[1]!
    const finalLine = Number(m[2])
    i++
    let author = meta.get(sha)?.author ?? ""
    let time = meta.get(sha)?.time ?? 0
    let summary = meta.get(sha)?.summary ?? ""
    let content = ""
    for (; i < lines.length; i++) {
      const line = lines[i]!
      if (line.startsWith("\t")) {
        content = line.slice(1)
        i++
        break
      }
      if (line.startsWith("author ")) author = line.slice("author ".length)
      else if (line.startsWith("author-time ")) time = Number(line.slice("author-time ".length))
      else if (line.startsWith("summary ")) summary = line.slice("summary ".length)
    }
    meta.set(sha, { author, time, summary })
    const last = chunks.at(-1)
    if (last && last.sha === sha && last.startLine + last.lines.length === finalLine) {
      last.lines.push(content)
    } else {
      chunks.push({ sha, author, time, summary, startLine: finalLine, lines: [content] })
    }
  }
  return chunks
}

function blameDate(time: number): string {
  return time ? new Date(time * 1000).toISOString().slice(0, 10) : "          "
}

/** Render chunks magit-style: hash/author/date on a chunk's first line,
 *  blank prefix on its continuation lines. Returns the buffer text and the
 *  full sha for each rendered line (for RET). */
export function renderBlame(chunks: BlameChunk[]): { text: string; lineShas: string[] } {
  const authorWidth = Math.min(16, Math.max(6, ...chunks.map(c => c.author.length)))
  const out: string[] = []
  const lineShas: string[] = []
  for (const chunk of chunks) {
    const info = `${chunk.sha.slice(0, 8)} ${chunk.author.slice(0, authorWidth).padEnd(authorWidth)} ${blameDate(chunk.time)}`
    const blank = " ".repeat(info.length)
    chunk.lines.forEach((line, i) => {
      out.push(`${i === 0 ? info : blank} ${line}`)
      lineShas.push(chunk.sha)
    })
  }
  return { text: out.join("\n"), lineShas }
}

export const BLAME_SHAS_LOCAL = "magit-blame-line-shas"

export function blameShaAtPoint(buffer: BufferModel): string | null {
  const shas = (buffer.locals.get(BLAME_SHAS_LOCAL) as string[] | undefined) ?? []
  const line = buffer.text.slice(0, buffer.point).split("\n").length - 1
  return shas[line] ?? null
}

/** Move point to the first line of the next/previous chunk boundary. */
export function blameChunkTarget(buffer: BufferModel, dir: 1 | -1): number | null {
  const shas = (buffer.locals.get(BLAME_SHAS_LOCAL) as string[] | undefined) ?? []
  const lines = buffer.text.split("\n")
  const current = buffer.text.slice(0, buffer.point).split("\n").length - 1
  const starts: number[] = []
  for (let i = 0; i < shas.length; i++) {
    if (i === 0 || shas[i] !== shas[i - 1]) starts.push(i)
  }
  const target = dir > 0 ? starts.find(s => s > current) : [...starts].reverse().find(s => s < current)
  if (target == null) return null
  let offset = 0
  for (let i = 0; i < target; i++) offset += lines[i]!.length + 1
  return offset
}
