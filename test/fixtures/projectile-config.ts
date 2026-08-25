import type { Editor } from "../../src/kernel/editor"
import { homedir } from "node:os"
import { join } from "node:path"
import { install as installStephenFixture } from "./stephen-config"
import { install as installCompile } from "../../plugins/compile"
import { install as installNextError } from "../../plugins/next-error"
import { install as installPersist } from "../../plugins/persist"

/** Stephen-like fixture plus projectile package (C-c p). */
export async function install(editor: Editor): Promise<void> {
  const packagesDir = process.env.JEMACS_PACKAGES ?? join(homedir(), ".jemacs", "packages")
  const { install: installProjectile } = await import(join(packagesDir, "projectile/projectile.ts"))
  await installStephenFixture(editor)
  installCompile(editor)
  installNextError(editor)
  installPersist(editor)
  await installProjectile(editor)
}
