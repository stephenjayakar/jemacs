import { registerClient } from "../client"
import { serverBinaryAvailable } from "../server-path"
import { stdioConnection } from "../stdio"

/** Lean 4 server — `lake serve` inside a lake project, falling back to bare `lean --server`. */
export function registerLeanClient(): void {
  registerClient({
    serverId: "lean",
    majorModes: ["lean4"],
    priority: 10,
    languageId: () => "lean4",
    newConnection: stdioConnection(
      () => (serverBinaryAvailable("lake") ? ["lake", "serve"] : ["lean", "--server"]),
      () => serverBinaryAvailable("lake") || serverBinaryAvailable("lean"),
    ),
  })
}
