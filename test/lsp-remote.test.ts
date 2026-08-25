import { expect, test, mock } from "bun:test"
import { defcustom, getCustom, setCustom, resetCustom } from "../src/runtime/custom"
import { serverBinaryAvailable } from "../src/lsp/server-path"
import { stdioConnection } from "../src/lsp/stdio"

test("remote LSP connection routing and validation", async () => {
  // 1. Check custom variable registration
  defcustom("lsp-remote-host", "string", null, "Remote SSH host to run language servers on.")
  expect(getCustom<string | null>("lsp-remote-host")).toBeNull()

  // 2. Setting remote host should make server binary available globally without local check
  setCustom("lsp-remote-host", "test-remote-workstation")
  expect(getCustom<string>("lsp-remote-host")).toBe("test-remote-workstation")
  expect(serverBinaryAvailable("gopls")).toBe(true)

  // 3. Connection test fallback should also evaluate to true for any command
  const conn = stdioConnection(["gopls", "--some-flag"])
  expect(conn.test?.()).toBe(true)

  // Clean up custom variable after test
  resetCustom("lsp-remote-host")
})
