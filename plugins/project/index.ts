import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { findProjectRoot } from "../../src/lsp/project-root"
import { spawnProcess } from "../../src/platform/runtime"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { compilationStart, lastCompileCommand } from "../compile"

export { findProjectRoot }

const ROOT_MARKERS = [".git", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "package.json", "go.mod", "Cargo.toml"]

/** Directory-taking, null-returning adapter over `findProjectRoot` so project/magit agree with compile/lsp. */
export async function projectRoot(dir: string): Promise<string | null> {
  const start = resolve(dir)
  const found = await findProjectRoot(join(start, "_"))
  if (found !== start) return found
  // findProjectRoot returns `start` both for "marker at start" and "no marker"; disambiguate.
  for (const m of ROOT_MARKERS) {
    const ok = await access(join(found, m)).then(() => true, () => false)
    if (ok) return found
  }
  return null
}

export async function projectFiles(root: string): Promise<string[]> {
  const proc = spawnProcess({ cmd: ["git", "ls-files", "-z"], cwd: root, stdout: "pipe", stderr: "pipe" })
  const out = proc.stdout ? await new Response(proc.stdout).text() : ""
  await proc.exited
  return out.split("\0").filter(Boolean)
}

function projectListFile(): string {
  return getCustom<string>("project-list-file") ?? join(homedir(), ".jemacs", "projects.json")
}

export async function readProjectList(): Promise<string[]> {
  const text = await readFile(projectListFile(), "utf8").catch(() => null)
  if (!text) return []
  try {
    const data = JSON.parse(text) as unknown
    return Array.isArray(data) ? data.map(String) : []
  } catch {
    return []
  }
}

export async function writeProjectList(roots: string[]): Promise<void> {
  const file = projectListFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(roots, null, 2), "utf8")
}

export async function rememberProject(root: string): Promise<void> {
  const list = await readProjectList()
  const i = list.indexOf(root)
  if (i === 0) return
  if (i > 0) list.splice(i, 1)
  list.unshift(root)
  await writeProjectList(list)
}

async function projectCurrent(editor: Editor, override?: string): Promise<string | null> {
  const start = override ?? editor.currentBuffer.directory() ?? process.cwd()
  const root = await projectRoot(start)
  if (!root) editor.message(`No project found for ${start}`)
  return root
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defcustom("project-list-file", "string", join(homedir(), ".jemacs", "projects.json"),
    "File where the list of known project roots is persisted.")

  editor.command("project-root", async ({ editor, args }) => {
    const root = await projectCurrent(editor, args[0])
    if (root) editor.message(root)
    return root
  }, "Echo the root directory of the current project.")

  editor.command("project-find-file", async ({ editor, args }) => {
    const root = await projectCurrent(editor, args[0])
    if (!root) return
    await rememberProject(root)
    const files = await projectFiles(root)
    if (!files.length) {
      editor.message(`No tracked files in ${root}`)
      return
    }
    const choice = await editor.completingRead("Find file in project: ", {
      collection: files,
      history: "project-file",
    })
    if (!choice) return
    await editor.openFile(join(root, choice))
  }, "Visit a file in the current project, with completion over git ls-files.")

  editor.command("project-switch-project", async ({ editor }) => {
    const roots = await readProjectList()
    if (!roots.length) {
      editor.message("No known projects")
      return
    }
    const root = await editor.completingRead("Switch to project: ", {
      collection: roots,
      history: "project",
    })
    if (!root) return
    await editor.run("project-find-file", [root])
  }, "Switch to a known project root and find a file in it.")

  editor.command("project-compile", async ({ editor, args }) => {
    const root = await projectCurrent(editor)
    if (!root) return
    const cmd = args[0] ?? await editor.prompt("Compile command: ", lastCompileCommand(editor), "compile-command")
    if (!cmd) return
    await compilationStart(editor, cmd, root)
  }, "Run `compile` with the project root as default-directory.")

  editor.key("C-x p f", "project-find-file")
  editor.key("C-x C-z", "project-find-file")
  editor.key("C-x p p", "project-switch-project")
  editor.key("C-x p c", "project-compile")
}
