import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"

export type Pty = {
  pid: number
  write(data: string): void
  resize(rows: number, cols: number): void
  onData(fn: (chunk: string) => void): void
  onExit(fn: (code: number | null) => void): void
  kill(): void
}

type PtyOptions = {
  cwd?: string
  rows?: number
  cols?: number
  env?: Record<string, string>
}

export function spawnPty(argv: string[], opts?: PtyOptions): Pty {
  if (argv.length === 0) throw new Error("spawnPty requires a command")
  const proc = spawn(pythonCommand(), ["-u", "-c", PY_PTY_BRIDGE, ...argv], {
    cwd: opts?.cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      LINES: String(opts?.rows ?? 24),
      COLUMNS: String(opts?.cols ?? 80),
      ...opts?.env,
    },
    stdio: "pipe",
  })

  const dataHandlers: Array<(s: string) => void> = []
  const exitHandlers: Array<(c: number | null) => void> = []

  proc.stdout.setEncoding("utf8")
  proc.stderr.setEncoding("utf8")
  proc.stdout.on("data", chunk => { for (const h of dataHandlers) h(chunk) })
  proc.stderr.on("data", chunk => { for (const h of dataHandlers) h(chunk) })
  proc.on("exit", code => { for (const h of exitHandlers) h(code) })
  proc.on("error", error => {
    for (const h of dataHandlers) h(`term: ${error.message}\r\n`)
    for (const h of exitHandlers) h(null)
  })

  return {
    pid: proc.pid ?? -1,
    write(data) { writeData(proc, data) },
    resize(rows, cols) { writeControl(proc, `R ${Math.max(1, rows)} ${Math.max(1, cols)}`) },
    onData(fn) { dataHandlers.push(fn) },
    onExit(fn) { exitHandlers.push(fn) },
    kill() { proc.kill() },
  }
}

function writeData(proc: ChildProcessWithoutNullStreams, data: string): void {
  if (!proc.stdin.destroyed) proc.stdin.write(`D ${Buffer.from(data, "utf8").toString("base64")}\n`)
}

function writeControl(proc: ChildProcessWithoutNullStreams, command: string): void {
  if (!proc.stdin.destroyed) proc.stdin.write(`${command}\n`)
}

function pythonCommand(): string {
  if (process.env.PYTHON) return process.env.PYTHON
  if (process.platform === "darwin" && existsSync("/usr/bin/python3")) return "/usr/bin/python3"
  return "python3"
}

const PY_PTY_BRIDGE = String.raw`
import base64, fcntl, os, pty, selectors, signal, struct, sys, termios

argv = sys.argv[1:]
if not argv:
    raise SystemExit("missing command")

pid, master = pty.fork()
if pid == 0:
    os.execvpe(argv[0], argv, os.environ)

selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ, "pty")
selector.register(sys.stdin.buffer, selectors.EVENT_READ, "stdin")

def resize(rows, cols):
    winsize = struct.pack("HHHH", max(1, rows), max(1, cols), 0, 0)
    fcntl.ioctl(master, termios.TIOCSWINSZ, winsize)
    try:
        os.kill(pid, signal.SIGWINCH)
    except ProcessLookupError:
        pass

while True:
    for key, _mask in selector.select():
        if key.data == "pty":
            try:
                data = os.read(master, 4096)
            except OSError:
                raise SystemExit(0)
            if not data:
                raise SystemExit(0)
            os.write(sys.stdout.fileno(), data)
        else:
            line = sys.stdin.buffer.readline()
            if not line:
                raise SystemExit(0)
            if line.startswith(b"D "):
                os.write(master, base64.b64decode(line[2:].strip()))
            elif line.startswith(b"R "):
                parts = line.decode("ascii", "replace").strip().split()
                if len(parts) == 3:
                    resize(int(parts[1]), int(parts[2]))
`
