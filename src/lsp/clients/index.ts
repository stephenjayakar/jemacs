import { registerGoplsClient } from "./gopls"
import { registerPylspClient } from "./pylsp"
import { registerRustAnalyzerClient } from "./rust-analyzer"
import { registerTypescriptLanguageServerClient } from "./typescript"
import { registerYamlLanguageServerClient } from "./yaml"
import { registerLeanClient } from "./lean"

/** serverId → shell command for `lsp-install-server`. Mirrors lsp-mode's
 *  per-client `:download-server-fn`; lives here (not on `LspClient`) so the
 *  type stays connection-only and plugins can extend the map. */
export const clientInstallCmds: Record<string, string> = {
  gopls: "go install golang.org/x/tools/gopls@latest",
  pylsp: "pip install 'python-lsp-server[all]'",
  "rust-analyzer": "rustup component add rust-analyzer",
  "typescript-language-server": "npm install -g typescript-language-server typescript",
  "yaml-language-server": "npm install -g yaml-language-server",
  lean: "elan toolchain install stable",
}

export function registerAllLspClients(): void {
  registerPylspClient()
  registerGoplsClient()
  registerTypescriptLanguageServerClient()
  registerRustAnalyzerClient()
  registerYamlLanguageServerClient()
  registerLeanClient()
}
