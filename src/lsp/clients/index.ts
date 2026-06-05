import { registerGoplsClient } from "./gopls"
import { registerPylspClient } from "./pylsp"
import { registerRustAnalyzerClient } from "./rust-analyzer"
import { registerTypescriptLanguageServerClient } from "./typescript"
import { registerYamlLanguageServerClient } from "./yaml"
import { registerLeanClient } from "./lean"

export function registerAllLspClients(): void {
  registerPylspClient()
  registerGoplsClient()
  registerTypescriptLanguageServerClient()
  registerRustAnalyzerClient()
  registerYamlLanguageServerClient()
  registerLeanClient()
}
