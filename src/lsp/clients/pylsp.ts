import { registerClient, activateOn } from "../client"
import { stdioConnection } from "../stdio"

/** Port of `lsp-pylsp.el` client registration (simplified initialization). */
export function registerPylspClient(): void {
  registerClient({
    serverId: "pylsp",
    majorModes: ["python"],
    priority: -1,
    activationFn: activateOn("python"),
    languageId: () => "python",
    newConnection: stdioConnection(["pylsp"], () => Bun.which("pylsp") != null),
    initializationOptions: {
      pylsp: {
        plugins: {
          jedi_completion: { enabled: true },
          jedi_definition: { enabled: true },
          jedi_hover: { enabled: true },
          rope_completion: { enabled: false },
        },
      },
    },
  })
}
