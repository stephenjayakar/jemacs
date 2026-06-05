import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Editor } from "../kernel/editor"
import type { Evaluator } from "../runtime/evaluator"
import { loadStartupConfig } from "./startup"

export function userConfigPath(): string {
  return join(homedir(), ".jemacs", "init.ts")
}

/** Load ~/.jemacs/init.ts when present (same contract as --config modules). */
export async function installUserConfig(editor: Editor, evaluator: Evaluator): Promise<void> {
  const path = userConfigPath()
  if (!existsSync(path)) return
  await loadStartupConfig(editor, evaluator, path)
}
