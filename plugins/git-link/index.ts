import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { killNew } from "../../src/runtime/kill-ring"
import { spawnProcess } from "../../src/platform/runtime"

/**
 * `git-link`: copy a browser URL for the current file and line on the forge.
 *
 * Forge URL shapes are stable and few, so they live in a table rather than being probed;
 * an unrecognised host falls back to the GitHub layout, which GitLab and most
 * self-hosted forges also accept.
 */

defcustom(
  "git-link-default-branch",
  "string",
  "master",
  "Branch to link against when the current branch has no upstream.",
)

defcustom(
  "git-link-use-commit",
  "boolean",
  false,
  "Link to the current commit SHA instead of a branch name.",
)

/** Normalise `git remote get-url` output to `host` + `owner/repo`. */
export function parseRemote(url: string): { host: string; path: string } | null {
  const trimmed = url.trim().replace(/\.git$/, "")
  if (!trimmed) return null

  // URL-style first: `ssh://git@host:2222/owner/repo` also matches the scp pattern
  // below, so testing scp first would mis-split it at the port colon.
  const proto = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(trimmed)
  if (proto) return { host: proto[1]!.replace(/:\d+$/, ""), path: proto[2]!.replace(/^\/+/, "") }

  // scp-style: git@github.com:owner/repo
  const scp = /^[^@]+@([^:]+):(.+)$/.exec(trimmed)
  if (scp) return { host: scp[1]!, path: scp[2]!.replace(/^\/+/, "") }

  return null
}

/**
 * Build the forge URL for `file` at `line` on `ref`.
 *
 * `line` is 1-based, matching what the forges expect and what the editor reports.
 */
export function buildGitLink(
  remote: { host: string; path: string },
  ref: string,
  file: string,
  line: number,
): string {
  const { host, path } = remote
  const base = `https://${host}/${path}`
  const encodedRef = encodeURIComponent(ref)

  if (host.includes("bitbucket")) {
    return `${base}/src/${encodedRef}/${file}#lines-${line}`
  }
  if (host.includes("sourcehut") || host.startsWith("git.sr.ht")) {
    return `${base}/tree/${encodedRef}/item/${file}#L${line}`
  }
  // GitHub layout; GitLab and most self-hosted forges use the same shape.
  return `${base}/blob/${encodedRef}/${file}#L${line}`
}

async function runGit(args: string[], cwd: string): Promise<string | null> {
  try {
    const proc = spawnProcess({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
    const chunks: string[] = []
    if (proc.stdout) {
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value?.length) chunks.push(decoder.decode(value, { stream: true }))
      }
    }
    const code = await proc.exited
    return code === 0 ? chunks.join("").trim() : null
  } catch {
    return null
  }
}

/** 1-based line number of `point`. */
function lineAtPoint(buffer: BufferModel): number {
  let line = 1
  const limit = Math.min(buffer.point, buffer.text.length)
  for (let i = 0; i < limit; i++) if (buffer.text[i] === "\n") line++
  return line
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const linkForBuffer = async (buffer: BufferModel): Promise<string | null> => {
    if (!buffer.path) {
      editor.message("Current buffer is not visiting a file")
      return null
    }
    const cwd = buffer.directory() ?? process.cwd()

    const root = await runGit(["rev-parse", "--show-toplevel"], cwd)
    if (!root) {
      editor.message("Not inside a git repository")
      return null
    }

    const remoteUrl = await runGit(["remote", "get-url", "origin"], cwd)
    const remote = remoteUrl ? parseRemote(remoteUrl) : null
    if (!remote) {
      editor.message("No 'origin' remote, or its URL could not be parsed")
      return null
    }

    // Prefer the current branch; fall back to the configured default when detached or
    // when the branch only exists locally.
    let ref: string
    if (getCustom<boolean>("git-link-use-commit")) {
      ref = await runGit(["rev-parse", "HEAD"], cwd) ?? "HEAD"
    } else {
      const branch = await runGit(["symbolic-ref", "--short", "-q", "HEAD"], cwd)
      const onRemote = branch
        ? await runGit(["ls-remote", "--exit-code", "--heads", "origin", branch], cwd)
        : null
      ref = branch && onRemote ? branch : getCustom<string>("git-link-default-branch") ?? "master"
    }

    const relative = buffer.path.startsWith(root)
      ? buffer.path.slice(root.length).replace(/^\/+/, "")
      : buffer.path
    return buildGitLink(remote, ref, relative, lineAtPoint(buffer))
  }

  ctx.command("git-link", async ({ editor, buffer }) => {
    const url = await linkForBuffer(buffer)
    if (!url) return
    killNew(editor, url)
    editor.message(`Copied ${url}`)
  }, "Copy a forge URL for the current file and line to the kill ring.")

  ctx.command("git-link-commit", async ({ editor, buffer }) => {
    const cwd = buffer.directory() ?? process.cwd()
    const remoteUrl = await runGit(["remote", "get-url", "origin"], cwd)
    const remote = remoteUrl ? parseRemote(remoteUrl) : null
    const sha = await runGit(["rev-parse", "HEAD"], cwd)
    if (!remote || !sha) {
      editor.message("Could not determine origin remote or HEAD")
      return
    }
    const url = `https://${remote.host}/${remote.path}/commit/${sha}`
    killNew(editor, url)
    editor.message(`Copied ${url}`)
  }, "Copy a forge URL for the current commit to the kill ring.")
}
