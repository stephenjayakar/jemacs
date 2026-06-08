import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { findProjectRoot } from "../../src/lsp/project-root"
import { spawnProcess } from "../../src/platform/runtime"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { compilationStart, lastCompileCommand } from "../compile"
import { grepProject } from "../next-error"

export { findProjectRoot }

type ProjectSwitchCommand = [command: string, label: string]

const ROOT_MARKERS = [".git", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "package.json", "go.mod", "Cargo.toml"]
const DEFAULT_PROJECT_SWITCH_COMMANDS: ProjectSwitchCommand[] = [
  ["project-find-file", "Find file"],
  ["project-find-regexp", "Find regexp"],
  ["project-find-dir", "Find directory"],
  ["project-vc-dir", "VC-Dir"],
  ["project-eshell", "Eshell"],
]

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

export async function projectDirectories(root: string): Promise<string[]> {
  const dirs = new Set<string>(["."])
  for (const file of await projectFiles(root)) {
    let dir = dirname(file)
    while (dir && dir !== ".") {
      dirs.add(dir)
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return [...dirs].sort((a, b) => a.localeCompare(b))
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

function projectSwitchCommands(editor: Editor): ProjectSwitchCommand[] {
  const custom = getCustom<unknown>("project-switch-commands")
  const commands = Array.isArray(custom) ? custom : DEFAULT_PROJECT_SWITCH_COMMANDS
  return commands.flatMap(entry => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") return []
    const command = entry[0]
    if (!editor.commands.get(command)) return []
    return [[command, typeof entry[1] === "string" ? entry[1] : command] satisfies ProjectSwitchCommand]
  })
}

export async function projectCurrent(editor: Editor, options: { directory?: string } = {}): Promise<string | null> {
  const start = options.directory ?? editor.currentBuffer.directory() ?? process.cwd()
  return projectRoot(start)
}

async function requireCurrentProject(editor: Editor, directory?: string): Promise<string | null> {
  const start = directory ?? editor.currentBuffer.directory() ?? process.cwd()
  const root = await projectCurrent(editor, { directory: start })
  if (!root) editor.message(`No project found for ${start}`)
  return root
}

async function bufferProjectRoot(buffer: BufferModel): Promise<string | null> {
  const localRoot = buffer.locals.get("magit-root")
  const localDefaultDirectory = buffer.locals.get("default-directory")
  const start = typeof localRoot === "string"
    ? localRoot
    : typeof localDefaultDirectory === "string"
      ? localDefaultDirectory
      : buffer.directory()
  return start ? projectRoot(start) : null
}

export async function projectBuffers(editor: Editor, root: string): Promise<BufferModel[]> {
  const expected = resolve(root)
  const buffers: BufferModel[] = []
  for (const buffer of editor.buffers.values()) {
    if (buffer.kind === "minibuffer") continue
    const found = await bufferProjectRoot(buffer)
    if (found && resolve(found) === expected) buffers.push(buffer)
  }
  return buffers
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defcustom("project-list-file", "string", join(homedir(), ".jemacs", "projects.json"),
    "File where the list of known project roots is persisted.")
  defcustom("project-switch-commands", "sexp", DEFAULT_PROJECT_SWITCH_COMMANDS,
    "Commands offered by project-switch-project.")

  editor.commands.define("project-current", async ({ editor, args }) =>
    projectCurrent(editor, { directory: args[0] }),
  { description: "Return the current project root, or null when none is found." })

  editor.commands.define("project-root", async ({ editor, args }) => {
    if (args[0]) return resolve(args[0])
    const root = await requireCurrentProject(editor)
    if (root) editor.message(root)
    return root
  }, { description: "Return the root directory of a project." })

  editor.command("project-find-file", async ({ editor, args }) => {
    const root = await requireCurrentProject(editor, args[0])
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

  editor.command("project-find-dir", async ({ editor, args }) => {
    const root = await requireCurrentProject(editor, args[0])
    if (!root) return
    await rememberProject(root)
    const dirs = await projectDirectories(root)
    const choice = await editor.completingRead("Find directory in project: ", {
      collection: dirs,
      history: "project-directory",
    })
    if (!choice) return
    await editor.run("dired", [choice === "." ? root : join(root, choice)])
  }, "Start Dired in a directory inside the current project.")

  editor.command("project-find-regexp", async ({ editor, args }) => {
    const firstArgIsRoot = args[0] != null && await projectRoot(args[0]) === resolve(args[0])
    const root = await requireCurrentProject(editor, firstArgIsRoot ? args[0] : args[1])
    if (!root) return
    await rememberProject(root)
    await grepProject(editor, {
      cwd: root,
      pattern: firstArgIsRoot ? undefined : args[0],
      prompt: "Find regexp in project: ",
    })
  }, "Find all matches for REGEXP in the current project's roots.")

  editor.command("vc-dir", async ({ editor, buffer, args }) => {
    const dir = args[0] ?? buffer.directory() ?? process.cwd()
    if (editor.commands.get("magit-status")) {
      await editor.run("magit-status", [dir])
      return
    }
    await editor.run("dired", [dir])
  }, "Show the VC status for interesting files in and below DIR.")

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
    await rememberProject(root)
    const commands = projectSwitchCommands(editor)
    if (!commands.length) {
      editor.message("No project switch commands")
      return
    }
    const labels = commands.map(([command, label]) => `${label} (${command})`)
    const choice = await editor.completingRead("Run project command: ", {
      collection: labels,
      history: "project-command",
    })
    if (!choice) return
    const i = labels.indexOf(choice)
    const command = commands[i]?.[0]
    if (!command) return
    await editor.run(command, [root])
  }, "Switch to another project by running a command from project-switch-commands.")

  editor.command("project-dired", async ({ editor, args }) => {
    const root = await requireCurrentProject(editor, args[0])
    if (!root) return
    await rememberProject(root)
    await editor.run("dired", [root])
  }, "Start Dired in the current project's root.")

  editor.command("project-vc-dir", async ({ editor, args }) => {
    const root = await requireCurrentProject(editor, args[0])
    if (!root) return
    await rememberProject(root)
    await editor.run("vc-dir", [root])
  }, "Run VC-Dir in the current project's root.")

  editor.command("project-kill-buffers", async ({ editor, args }) => {
    const noConfirm = args.includes("no-confirm") || args.includes("true")
    const directory = args.find(arg => arg !== "no-confirm" && arg !== "true")
    const root = await requireCurrentProject(editor, directory)
    if (!root) return
    const buffers = await projectBuffers(editor, root)
    if (!buffers.length) {
      editor.message("No project buffers to kill")
      return
    }
    if (!noConfirm) {
      const answer = await editor.prompt(`Kill ${buffers.length} project buffer(s)? (y or n) `, "n", "project-kill-buffers")
      if (answer !== "y") {
        editor.message("Cancelled")
        return
      }
    }
    let killed = 0
    for (const buffer of buffers) if (editor.killBuffer(buffer.id)) killed++
    editor.message(`Killed ${killed} project buffer(s)`)
  }, "Kill the buffers belonging to the current project.")

  editor.command("project-compile", async ({ editor, args }) => {
    const root = await requireCurrentProject(editor)
    if (!root) return
    const cmd = args[0] ?? await editor.prompt("Compile command: ", lastCompileCommand(editor), "compile-command")
    if (!cmd) return
    await compilationStart(editor, cmd, root)
  }, "Run `compile` with the project root as default-directory.")

  editor.key("C-x p f", "project-find-file")
  editor.key("C-x p d", "project-find-dir")
  editor.key("C-x p g", "project-find-regexp")
  editor.key("C-x C-z", "project-find-file")
  editor.key("C-x p p", "project-switch-project")
  editor.key("C-x p v", "project-vc-dir")
  editor.key("C-x p S-d", "project-dired")
  editor.key("C-x p c", "project-compile")
  editor.key("C-x p k", "project-kill-buffers")
  editor.key("C-x v d", "vc-dir")
}
