import { ContentLengthMessageParser, serializeContentLength } from "../protocol/content-length"
import { connectTcp, spawnProcess, type SpawnHandle, type TcpHandle } from "../platform/runtime"
import type { DapEvent, DapMessage, DapRequest, DapResponse, JdapTransportDescriptor } from "./types"

type Pending = {
  command: string
  resolve: (body: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class DapConnection {
  private readonly parser = new ContentLengthMessageParser<DapMessage>()
  private readonly pending = new Map<number, Pending>()
  private readonly eventListeners = new Set<(event: DapEvent) => void | Promise<void>>()
  private readonly requestListeners = new Set<(request: DapRequest) => void | Promise<void>>()
  private sequence = 0
  private disposed = false

  constructor(
    private readonly sendRaw: (payload: string) => void,
    private readonly log?: (direction: "send" | "receive", message: DapMessage) => void,
  ) {}

  onEvent(listener: (event: DapEvent) => void | Promise<void>): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onRequest(listener: (request: DapRequest) => void | Promise<void>): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  feed(chunk: string | Uint8Array): void {
    for (const message of this.parser.feed(chunk)) {
      this.log?.("receive", message)
      if (message.type === "response") {
        const pending = this.pending.get(message.request_seq)
        if (!pending) continue
        this.pending.delete(message.request_seq)
        clearTimeout(pending.timer)
        if (message.success) pending.resolve(message.body ?? {})
        else pending.reject(new Error(message.message ?? `${message.command} failed`))
      } else if (message.type === "event") {
        for (const listener of this.eventListeners) void listener(message)
      } else {
        for (const listener of this.requestListeners) void listener(message)
      }
    }
  }

  request(command: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (this.disposed) return Promise.reject(new Error("DAP connection is closed"))
    const seq = ++this.sequence
    const message: DapRequest = { seq, type: "request", command, arguments: args }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new Error(`Timeout waiting for DAP ${command}`))
      }, timeoutMs)
      this.pending.set(seq, { command, resolve, reject, timer })
      this.send(message)
    })
  }

  respond(request: DapRequest, body: Record<string, unknown> = {}, error?: Error): void {
    const message: DapResponse = {
      seq: ++this.sequence,
      type: "response",
      request_seq: request.seq,
      success: !error,
      command: request.command,
      body: error ? undefined : body,
      message: error?.message,
    }
    this.send(message)
  }

  dispose(reason = "DAP connection closed"): void {
    if (this.disposed) return
    this.disposed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
    this.eventListeners.clear()
    this.requestListeners.clear()
  }

  private send(message: DapMessage): void {
    this.log?.("send", message)
    this.sendRaw(serializeContentLength(message))
  }
}

export type OpenDapTransport = {
  connection: DapConnection
  adapterProcess?: SpawnHandle
  close(): void
}

async function readStream(stream: ReadableStream<Uint8Array>, receive: (chunk: Uint8Array) => void): Promise<void> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) receive(value)
    }
  } finally {
    reader.releaseLock()
  }
}

async function connectWithRetry(host: string, port: number, timeoutMs = 10_000): Promise<TcpHandle> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    const socket = connectTcp(host, port)
    try {
      await socket.closed
      return socket
    } catch (error) {
      lastError = error
      socket.close()
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  throw new Error(`Unable to connect to debug adapter at ${host}:${port}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

export async function openDapTransport(
  descriptor: JdapTransportDescriptor,
  options: {
    log?: (direction: "send" | "receive", message: DapMessage) => void
    stderr?: (text: string) => void
    exited?: (code: number | null) => void
  } = {},
): Promise<OpenDapTransport> {
  let adapterProcess: SpawnHandle | undefined
  let socket: TcpHandle | undefined
  let send: (payload: string) => void
  let stream: ReadableStream<Uint8Array>

  if (descriptor.kind === "stdio") {
    if (!descriptor.command.length) throw new Error("DAP stdio adapter command is empty")
    adapterProcess = spawnProcess({
      cmd: descriptor.command,
      cwd: descriptor.cwd,
      env: descriptor.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    if (!adapterProcess.stdin || !adapterProcess.stdout) throw new Error("Debug adapter did not expose stdio pipes")
    send = payload => adapterProcess!.stdin!.write(payload)
    stream = adapterProcess.stdout
  } else {
    if (descriptor.process?.length) {
      adapterProcess = spawnProcess({
        cmd: descriptor.process,
        cwd: descriptor.cwd,
        env: descriptor.env,
        stdout: "pipe",
        stderr: "pipe",
      })
    }
    socket = await connectWithRetry(descriptor.host, descriptor.port)
    send = payload => socket!.write(payload)
    stream = socket.readable
  }

  const connection = new DapConnection(send, options.log)
  void readStream(stream, chunk => connection.feed(chunk)).finally(() => connection.dispose())
  if (adapterProcess?.stderr) {
    const decoder = new TextDecoder()
    void readStream(adapterProcess.stderr, chunk => options.stderr?.(decoder.decode(chunk, { stream: true })))
  }
  if (descriptor.kind === "tcp" && adapterProcess?.stdout) {
    const decoder = new TextDecoder()
    void readStream(adapterProcess.stdout, chunk => options.stderr?.(decoder.decode(chunk, { stream: true })))
  }
  if (adapterProcess) void adapterProcess.exited.then(code => options.exited?.(code))

  return {
    connection,
    adapterProcess,
    close() {
      connection.dispose()
      socket?.close()
      adapterProcess?.stdin?.end()
      adapterProcess?.kill()
    },
  }
}
