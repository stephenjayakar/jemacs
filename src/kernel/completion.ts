import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { readdir } from "node:fs/promises"

export function expandUserPath(input: string): string {
  if (input.startsWith("~/")) return join(homedir(), input.slice(2))
  if (input === "~") return homedir()
  return input
}

export function splitCompletionInput(input: string, baseDirectory = process.cwd()): { directory: string; prefix: string } {
  const expanded = expandUserPath(input)
  const lastSlash = expanded.lastIndexOf("/")
  if (lastSlash === -1) {
    return { directory: baseDirectory, prefix: expanded }
  }
  const directory = expanded.slice(0, lastSlash + 1) || "/"
  const prefix = expanded.slice(lastSlash + 1)
  return { directory, prefix }
}

export async function fileCompletionCandidates(input: string, baseDirectory = process.cwd()): Promise<string[]> {
  const { directory, prefix } = splitCompletionInput(input, baseDirectory)
  const dirPath = directory.startsWith("/") ? directory : resolve(process.cwd(), directory)
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.name.startsWith(prefix))
    .map(entry => {
      const path = join(dirPath, entry.name)
      return entry.isDirectory() ? `${path}/` : path
    })
    .sort((a, b) => a.localeCompare(b))
}
