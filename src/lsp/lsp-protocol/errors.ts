/** lsp--errors from lsp-mode.el */

export const lspErrors: ReadonlyArray<readonly [number, string]> = [
  [-32700, "Parse Error"],
  [-32600, "Invalid Request"],
  [-32601, "Method not Found"],
  [-32602, "Invalid Parameters"],
  [-32603, "Internal Error"],
  [-32099, "Server Start Error"],
  [-32000, "Server End Error"],
  [-32002, "Server Not Initialized"],
  [-32001, "Unknown Error Code"],
  [-32800, "Request Cancelled"],
]

export function lspErrorString(code: number, message: string): string {
  const friendly = lspErrors.find(([c]) => c === code)?.[1] ?? "Unknown error"
  return `Error from the Language Server: ${message} (${friendly})`
}
