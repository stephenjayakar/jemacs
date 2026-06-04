import type { LspConnection } from "./client"

/** Port of `lsp-stdio-connection` from lsp-mode.el. */
export function stdioConnection(command: string[] | (() => string[]), testCommand?: () => boolean): LspConnection {
  return {
    connect({ onData, onExit, serverId, cwd }) {
      const argv = typeof command === "function" ? command() : command
      const proc = Bun.spawn({
        cmd: argv,
        cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = proc.stdout
      if (!stdout) throw new Error(`Failed to start ${serverId}: no stdout`)
      void (async () => {
        const reader = stdout.getReader()
        const decoder = new TextDecoder()
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (value) onData(decoder.decode(value))
          }
        } finally {
          reader.releaseLock()
        }
      })()
      proc.exited.then(code => onExit(code)).catch(() => onExit(null))
      return {
        proc: { kill: () => proc.kill() },
        send(message: string) {
          proc.stdin?.write(message)
        },
      }
    },
    test: testCommand ?? (() => {
      const argv = typeof command === "function" ? command() : command
      return Bun.which(argv[0]!) != null
    }),
  }
}
