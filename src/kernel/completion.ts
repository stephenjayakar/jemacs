import { join, resolve } from "node:path"
import { cwd, homedir, isDirectory, readdir, stat } from "../platform/runtime"

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

export async function fileCompletionCandidates(input: string, baseDirectory = cwd()): Promise<string[]> {
  const { directory, prefix } = splitCompletionInput(input, baseDirectory)
  const dirPath = directory.startsWith("/") ? directory : resolve(baseDirectory, directory)
  const names = await readdir(dirPath.replace(/\/+$/, "") || "/")
  const pfx = prefix.toLowerCase()
  const matches = names.filter(n => n.toLowerCase().startsWith(pfx))
  const out = await Promise.all(matches.map(async name => {
    const path = join(dirPath, name)
    const st = await stat(path)
    return st && isDirectory(st) ? `${path}/` : path
  }))
  return out.sort((a, b) => a.localeCompare(b))
}
