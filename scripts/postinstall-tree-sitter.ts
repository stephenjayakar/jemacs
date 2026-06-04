import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const root = join(import.meta.dirname, "..", "node_modules", "tree-sitter")
const platform = process.platform
const arch = process.arch
const prebuildDir = join(root, "prebuilds", `${platform}-${arch}`)
const prebuildPath = join(prebuildDir, "tree-sitter.node")
const builtPath = join(root, "build", "Release", "tree_sitter_runtime_binding.node")

if (existsSync(prebuildPath)) {
  process.exit(0)
}

if (!existsSync(builtPath)) {
  const install = spawnSync("npm", ["run", "install"], { cwd: root, stdio: "inherit" })
  if (install.status !== 0) process.exit(install.status ?? 1)
}

if (!existsSync(builtPath)) {
  console.error("postinstall-tree-sitter: native binding missing after build")
  process.exit(1)
}

mkdirSync(prebuildDir, { recursive: true })
copyFileSync(builtPath, prebuildPath)
