import { basename, dirname, extname, relative, resolve, sep } from "node:path"
import type { Editor } from "../kernel/editor"
import { jdapCommandVariable } from "./api"
import type {
  JdapCompoundConfiguration,
  JdapContext,
  JdapInputDefinition,
  JdapLaunchConfiguration,
  LaunchJson,
} from "./types"

/** Remove JSONC comments without touching comment-like text inside strings. */
export function stripJsonComments(text: string): string {
  let output = ""
  let string = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const next = text[i + 1]
    if (string) {
      output += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') string = false
      continue
    }
    if (ch === '"') {
      string = true
      output += ch
    } else if (ch === "/" && next === "/") {
      output += "  "
      i += 2
      while (i < text.length && text[i] !== "\n") { output += " "; i++ }
      if (i < text.length) output += "\n"
    } else if (ch === "/" && next === "*") {
      output += "  "
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        output += text[i] === "\n" ? "\n" : " "
        i++
      }
      output += "  "
      i++
    } else output += ch
  }
  return output
}

export function stripTrailingCommas(text: string): string {
  let output = ""
  let string = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (string) {
      output += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') string = false
      continue
    }
    if (ch === '"') {
      string = true
      output += ch
      continue
    }
    if (ch === ",") {
      let next = i + 1
      while (/\s/.test(text[next] ?? "")) next++
      if (text[next] === "}" || text[next] === "]") continue
    }
    output += ch
  }
  return output
}

export function parseLaunchJson(text: string): LaunchJson {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripTrailingCommas(stripJsonComments(text)))
  } catch (error) {
    throw new Error(`Invalid launch.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== "object") throw new Error("launch.json must contain an object")
  const value = parsed as Partial<LaunchJson>
  if (value.version !== "0.2.0") throw new Error('launch.json version must be "0.2.0"')
  if (!Array.isArray(value.configurations)) throw new Error("launch.json configurations must be an array")
  const names = new Set<string>()
  for (const config of value.configurations) {
    if (!config || typeof config !== "object" || typeof config.name !== "string" || typeof config.type !== "string") {
      throw new Error("Every debug configuration needs string name and type fields")
    }
    if (config.request !== "launch" && config.request !== "attach") {
      throw new Error(`Configuration ${JSON.stringify(config.name)} must use request "launch" or "attach"`)
    }
    if (names.has(config.name)) throw new Error(`Duplicate debug configuration name: ${config.name}`)
    names.add(config.name)
  }
  for (const compound of value.compounds ?? []) {
    if (!compound || typeof compound.name !== "string" || !Array.isArray(compound.configurations)) {
      throw new Error("Every compound needs a name and configurations array")
    }
  }
  return value as LaunchJson
}

export function visibleLaunchItems(launch: LaunchJson): Array<JdapLaunchConfiguration | JdapCompoundConfiguration> {
  const items = [...launch.configurations, ...(launch.compounds ?? [])]
    .filter(item => item.presentation?.hidden !== true)
  return items.sort((a, b) => {
    const ga = a.presentation?.group ?? ""
    const gb = b.presentation?.group ?? ""
    return ga.localeCompare(gb)
      || (a.presentation?.order ?? 0) - (b.presentation?.order ?? 0)
      || a.name.localeCompare(b.name)
  })
}

export function resolveCompound(launch: LaunchJson, name: string): { compound: JdapCompoundConfiguration; configurations: JdapLaunchConfiguration[] } {
  const compound = launch.compounds?.find(item => item.name === name)
  if (!compound) throw new Error(`No debug compound named ${name}`)
  const configurations = compound.configurations.map(configName => {
    const config = launch.configurations.find(item => item.name === configName)
    if (!config) throw new Error(`Compound ${name} refers to missing configuration ${configName}`)
    return config
  })
  return { compound, configurations }
}

function variableValue(name: string, context: JdapContext): string | undefined {
  const file = context.file ? resolve(context.file) : undefined
  if (name === "workspaceFolder") return context.projectRoot
  if (name.startsWith("workspaceFolder:")) return context.workspaceFolders[name.slice("workspaceFolder:".length)]
  if (name === "file") return file
  if (name === "fileDirname") return file ? dirname(file) : undefined
  if (name === "fileBasename") return file ? basename(file) : undefined
  if (name === "fileBasenameNoExtension") return file ? basename(file, extname(file)) : undefined
  if (name === "fileExtname") return file ? extname(file) : undefined
  if (name === "relativeFile") return file ? relative(context.projectRoot, file) : undefined
  if (name === "relativeFileDirname") return file ? dirname(relative(context.projectRoot, file)) : undefined
  if (name === "cwd") return context.cwd
  if (name === "pathSeparator") return sep
  if (name.startsWith("env:")) return context.env(name.slice(4))
  if (name.startsWith("config:")) return context.configValues[name.slice(7)]
  return undefined
}

async function resolveInput(
  editor: Editor,
  id: string,
  inputs: JdapInputDefinition[],
  context: JdapContext,
  config: JdapLaunchConfiguration,
): Promise<string> {
  const input = inputs.find(candidate => candidate.id === id)
  if (!input) throw new Error(`No launch.json input named ${id}`)
  const prompt = input.description ?? `${id}: `
  if (input.type === "promptString") {
    const answer = await editor.prompt(prompt.endsWith(" ") ? prompt : `${prompt}: `, input.default ?? "", `jdap-input-${id}`, { mask: input.password })
    if (answer == null) throw new Error(`Debug input ${id} was cancelled`)
    return answer
  }
  if (input.type === "pickString") {
    if (!input.options?.length) throw new Error(`Debug input ${id} has no options`)
    const answer = await editor.completingRead(prompt.endsWith(" ") ? prompt : `${prompt}: `, {
      collection: input.options,
      initialValue: input.default,
      history: `jdap-input-${id}`,
    })
    if (answer == null) throw new Error(`Debug input ${id} was cancelled`)
    return answer
  }
  const command = input.command ?? id
  const resolver = jdapCommandVariable(command)
  if (!resolver) throw new Error(`Debug input ${id} requires unregistered command variable ${command}`)
  return await resolver(context, config, input)
}

export async function expandLaunchConfiguration(
  editor: Editor,
  config: JdapLaunchConfiguration,
  launch: Pick<LaunchJson, "inputs">,
  context: JdapContext,
): Promise<JdapLaunchConfiguration> {
  const inputCache = new Map<string, string>()
  const expandString = async (text: string): Promise<string> => {
    let output = ""
    let cursor = 0
    for (const match of text.matchAll(/\$\{([^}]+)\}/g)) {
      output += text.slice(cursor, match.index)
      const name = match[1]!
      let value: string | undefined
      if (name.startsWith("input:")) {
        const id = name.slice(6)
        value = inputCache.get(id)
        if (value == null) {
          value = await resolveInput(editor, id, launch.inputs ?? [], context, config)
          inputCache.set(id, value)
        }
      } else if (name.startsWith("command:")) {
        const command = name.slice(8)
        const resolver = jdapCommandVariable(command)
        if (!resolver) throw new Error(`Debug configuration requires unregistered command variable ${command}`)
        value = await resolver(context, config, { id: command, type: "command", command })
      } else value = variableValue(name, context)
      if (value == null) throw new Error(`Unable to resolve debug variable \${${name}}`)
      output += value
      cursor = (match.index ?? 0) + match[0].length
    }
    return output + text.slice(cursor)
  }
  const walk = async (value: unknown): Promise<unknown> => {
    if (typeof value === "string") return await expandString(value)
    if (Array.isArray(value)) return await Promise.all(value.map(walk))
    if (value && typeof value === "object") {
      const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await walk(item)] as const))
      return Object.fromEntries(entries)
    }
    return value
  }
  return await walk(config) as JdapLaunchConfiguration
}
