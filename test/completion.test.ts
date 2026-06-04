import { expect, test } from "bun:test"
import { fileCompletionCandidates, splitCompletionInput } from "../src/kernel/completion"

test("splitCompletionInput separates directory and filename prefix", () => {
  expect(splitCompletionInput("/tmp/foo")).toEqual({ directory: "/tmp/", prefix: "foo" })
  expect(splitCompletionInput("foo")).toEqual({ directory: process.cwd(), prefix: "foo" })
})

test("fileCompletionCandidates lists entries in a directory", async () => {
  const candidates = await fileCompletionCandidates(`${process.cwd()}/`)
  expect(candidates.length).toBeGreaterThan(0)
  expect(candidates.some(candidate => candidate.endsWith("/"))).toBe(true)
})
