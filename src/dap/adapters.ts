import { join } from "node:path"
import { env, fileExists, findFreeTcpPort, homedir, readdir, whichExecutable } from "../platform/runtime"
import { getCustom } from "../runtime/custom"
import { registerJdapAdapter } from "./api"
import type { JdapAdapterDescriptor } from "./types"

async function discoverJsDebug(): Promise<string | null> {
  const explicit = env("JEMACS_JS_DEBUG_PATH") ?? getCustom<string>("jdap-node-adapter-path")
  if (explicit && await fileExists(explicit)) return explicit
  const roots = [
    join(homedir(), ".vscode", "extensions"),
    join(homedir(), ".vscode-insiders", "extensions"),
    join(homedir(), ".cursor", "extensions"),
  ]
  const candidates: string[] = []
  for (const root of roots) {
    for (const entry of await readdir(root).catch(() => [])) {
      if (!entry.startsWith("ms-vscode.js-debug")) continue
      candidates.push(join(root, entry, "src", "dapDebugServer.js"))
    }
  }
  const application = "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/ms-vscode.js-debug/src/dapDebugServer.js"
  candidates.push(application)
  for (const candidate of candidates.sort().reverse()) if (await fileExists(candidate)) return candidate
  return null
}

export function installBuiltinJdapAdapters(): () => void {
  const disposers: Array<() => void> = []
  const python: JdapAdapterDescriptor = {
    types: ["debugpy", "python"],
    resolve(_config, context) {
      const command = getCustom<string>("jdap-python-command") ?? "python3"
      const executable = whichExecutable(command)
      if (!executable) throw new Error(`Python debugger unavailable: ${command} is not on PATH`)
      return { kind: "stdio", command: [executable, "-m", "debugpy.adapter"], cwd: context.projectRoot }
    },
  }
  const node: JdapAdapterDescriptor = {
    types: ["pwa-node", "node"],
    async resolve(_config, context) {
      const adapter = await discoverJsDebug()
      if (!adapter) {
        throw new Error("JavaScript debugger unavailable: set jdap-node-adapter-path or JEMACS_JS_DEBUG_PATH to js-debug/src/dapDebugServer.js")
      }
      const nodeCommand = getCustom<string>("jdap-node-command") ?? "node"
      const executable = whichExecutable(nodeCommand)
      if (!executable) throw new Error(`JavaScript debugger unavailable: ${nodeCommand} is not on PATH`)
      const port = await findFreeTcpPort()
      return {
        kind: "tcp",
        host: "127.0.0.1",
        port,
        process: [executable, adapter, String(port)],
        cwd: context.projectRoot,
      }
    },
  }
  disposers.push(registerJdapAdapter(python), registerJdapAdapter(node))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
