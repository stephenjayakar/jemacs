import { resolve } from "node:path"
import type { Editor } from "../kernel/editor"
import type { Evaluator } from "../runtime/evaluator"

export type ParsedStartupArgs = {
  configs: string[]
  files: string[]
}
export function parseStartupArgs(argv: string[], ignoredFlags = new Set(["--gui", "--smoke-gui"])): ParsedStartupArgs {
  const configs: string[] = []
  const files: string[] = []
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--config") {
      const value = argv[++i]
      if (!value) throw new Error("--config requires a value")
      configs.push(value)
      continue
    }
    if (arg.startsWith("--config=")) {
      configs.push(arg.slice("--config=".length))
      continue
    }
    if (ignoredFlags.has(arg)) continue
    if (!arg.startsWith("-")) files.push(arg)
  }
  return { configs, files }
}

export async function loadStartupConfig(editor: Editor, evaluator: Evaluator, config: string): Promise<void> {
  const mod = await evaluator.loadModule(resolve(config))
  if (typeof mod.install === "function") await mod.install(editor)
  else if (typeof mod.installDefaultConfig === "function") mod.installDefaultConfig(editor)
  else if (typeof mod.installStephenConfig === "function") mod.installStephenConfig(editor)
  else throw new Error(`Config ${config} must export install(editor) or installDefaultConfig(editor)`)
}
