import { describe, expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { BLAME_SHAS_LOCAL, blameChunkTarget, blameShaAtPoint, parseBlamePorcelain, renderBlame } from "../../plugins/magit/blame"

const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)

const PORCELAIN = [
  `${SHA_A} 1 1 2`,
  "author Alice",
  "author-time 1751500000",
  "summary first commit",
  "\tline one",
  `${SHA_A} 2 2`,
  "\tline two",
  `${SHA_B} 3 3 1`,
  "author Bob",
  "author-time 1751600000",
  "summary second commit",
  "\tline three",
  "",
].join("\n")

describe("parseBlamePorcelain", () => {
  test("groups consecutive same-commit lines into chunks", () => {
    const chunks = parseBlamePorcelain(PORCELAIN)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({ sha: SHA_A, author: "Alice", summary: "first commit", startLine: 1, lines: ["line one", "line two"] })
    expect(chunks[1]).toMatchObject({ sha: SHA_B, author: "Bob", lines: ["line three"] })
  })

  test("reuses metadata for repeated commits without headers", () => {
    const chunks = parseBlamePorcelain(PORCELAIN)
    expect(chunks[0]!.lines).toHaveLength(2)
    expect(chunks[0]!.author).toBe("Alice")
  })
})

describe("renderBlame", () => {
  test("prefixes chunk heads with hash/author/date, blanks continuations", () => {
    const { text, lineShas } = renderBlame(parseBlamePorcelain(PORCELAIN))
    const rows = text.split("\n")
    expect(rows[0]).toContain("aaaaaaaa")
    expect(rows[0]).toContain("Alice")
    expect(rows[0]).toContain("line one")
    expect(rows[1]).not.toContain("aaaaaaaa")
    expect(rows[1]).toContain("line two")
    expect(rows[2]).toContain("bbbbbbbb")
    expect(lineShas).toEqual([SHA_A, SHA_A, SHA_B])
  })
})

describe("blame buffer navigation", () => {
  function blameBuffer() {
    const { text, lineShas } = renderBlame(parseBlamePorcelain(PORCELAIN))
    const buffer = new BufferModel({ name: "*magit-blame*", text })
    buffer.locals.set(BLAME_SHAS_LOCAL, lineShas)
    return buffer
  }

  test("blameShaAtPoint resolves the full sha for the line", () => {
    const buffer = blameBuffer()
    buffer.point = 0
    expect(blameShaAtPoint(buffer)).toBe(SHA_A)
    buffer.point = buffer.text.indexOf("line three")
    expect(blameShaAtPoint(buffer)).toBe(SHA_B)
  })

  test("chunk motion jumps between chunk starts", () => {
    const buffer = blameBuffer()
    buffer.point = 0
    const next = blameChunkTarget(buffer, 1)
    expect(next).not.toBeNull()
    buffer.point = next!
    expect(blameShaAtPoint(buffer)).toBe(SHA_B)
    expect(blameChunkTarget(buffer, 1)).toBeNull()
    const prev = blameChunkTarget(buffer, -1)
    expect(prev).toBe(0)
  })
})
