import type {
  DapBreakpoint,
  DapCapabilities,
  DapEvent,
  DapRequest,
  DapScope,
  DapSessionState,
  DapStackFrame,
  DapThread,
  DapVariable,
  JdapLaunchConfiguration,
  JdapSourceBreakpoint,
  JdapTransportDescriptor,
} from "./types"
import { openDapTransport, type OpenDapTransport } from "./connection"

export type DapSessionSnapshot = {
  id: string
  name: string
  state: DapSessionState
  capabilities: DapCapabilities
  threads: DapThread[]
  selectedThreadId?: number
  frames: DapStackFrame[]
  selectedFrame?: DapStackFrame
  scopes: Array<DapScope & { variables: DapVariable[] }>
  output: Array<{ category: string; text: string }>
  error?: string
}

export type DapSessionHooks = {
  breakpoints(): JdapSourceBreakpoint[]
  breakpointChanged?(breakpoint: JdapSourceBreakpoint): void
  runInTerminal?(args: Record<string, unknown>): Promise<Record<string, unknown>>
  changed(session: DapSession): void
}

function array<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

export class DapSession {
  readonly id = crypto.randomUUID()
  state: DapSessionState = "starting"
  capabilities: DapCapabilities = {}
  threads: DapThread[] = []
  selectedThreadId?: number
  frames: DapStackFrame[] = []
  selectedFrame?: DapStackFrame
  scopes: Array<DapScope & { variables: DapVariable[] }> = []
  output: Array<{ category: string; text: string }> = []
  error?: string
  private transport?: OpenDapTransport
  private initializedResolve?: () => void
  private initialized = new Promise<void>(resolve => { this.initializedResolve = resolve })
  private stoppedGeneration = 0
  private readonly synchronizedBreakpointPaths = new Set<string>()

  constructor(
    readonly name: string,
    readonly config: JdapLaunchConfiguration,
    private readonly descriptor: JdapTransportDescriptor,
    private readonly hooks: DapSessionHooks,
    private readonly protocolLog?: (line: string) => void,
  ) {}

  snapshot(): DapSessionSnapshot {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      capabilities: this.capabilities,
      threads: this.threads,
      selectedThreadId: this.selectedThreadId,
      frames: this.frames,
      selectedFrame: this.selectedFrame,
      scopes: this.scopes,
      output: this.output,
      error: this.error,
    }
  }

  async start(): Promise<void> {
    try {
      this.transport = await openDapTransport(this.descriptor, {
        log: (direction, message) => this.protocolLog?.(`${direction} ${JSON.stringify(message)}`),
        stderr: text => this.appendOutput("adapter", text),
        exited: code => {
          if (this.state !== "terminated" && this.state !== "terminating") this.fail(`Debug adapter exited${code == null ? "" : ` with code ${code}`}`)
        },
      })
      this.transport.connection.onEvent(event => this.handleEvent(event))
      this.transport.connection.onRequest(request => this.handleReverseRequest(request))
      const initialize = await this.transport.connection.request("initialize", {
        clientID: "jemacs",
        clientName: "Jemacs",
        adapterID: this.config.type,
        pathFormat: "path",
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsVariablePaging: true,
        supportsRunInTerminalRequest: this.hooks.runInTerminal != null,
        locale: "en-US",
      })
      this.capabilities = initialize
      this.state = "configuring"
      this.changed()

      const requestArgs: Record<string, unknown> = { ...this.config }
      delete requestArgs.name
      delete requestArgs.type
      delete requestArgs.request
      delete requestArgs.presentation
      const launchResponse = this.transport.connection.request(this.config.request, requestArgs, 60_000)
      await Promise.race([
        this.initialized,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for DAP initialized event")), 30_000)),
      ])
      await this.synchronizeBreakpoints()
      if (this.capabilities.supportsConfigurationDoneRequest === true) {
        await this.transport.connection.request("configurationDone")
      }
      await launchResponse
      const currentState = (this as { state: DapSessionState }).state
      if (currentState !== "stopped" && currentState !== "terminated") this.state = "running"
      await this.refreshThreads().catch(() => {})
      this.changed()
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  async synchronizeBreakpoints(): Promise<void> {
    if (!this.transport) return
    const grouped = new Map<string, JdapSourceBreakpoint[]>()
    for (const breakpoint of this.hooks.breakpoints().filter(item => item.enabled)) {
      const list = grouped.get(breakpoint.path) ?? []
      list.push(breakpoint)
      grouped.set(breakpoint.path, list)
    }
    const paths = new Set([...this.synchronizedBreakpointPaths, ...grouped.keys()])
    for (const path of paths) {
      const sourceBreakpoints = grouped.get(path) ?? []
      const body = await this.transport.connection.request("setBreakpoints", {
        source: { path },
        breakpoints: sourceBreakpoints.map(item => ({
          line: item.line,
          condition: item.condition,
          hitCondition: item.hitCondition,
          logMessage: item.logMessage,
        })),
        sourceModified: false,
      })
      const actual = array<DapBreakpoint>(body.breakpoints)
      sourceBreakpoints.forEach((breakpoint, index) => {
        const result = actual[index]
        if (!result) return
        breakpoint.verified = result.verified
        breakpoint.message = result.message
        if (result.line) breakpoint.line = result.line
        this.hooks.breakpointChanged?.(breakpoint)
      })
      if (sourceBreakpoints.length) this.synchronizedBreakpointPaths.add(path)
      else this.synchronizedBreakpointPaths.delete(path)
    }
    this.changed()
  }

  async continue(): Promise<void> { await this.threadRequest("continue") }
  async pause(): Promise<void> { await this.threadRequest("pause", false) }
  async next(): Promise<void> { await this.threadRequest("next") }
  async stepIn(): Promise<void> { await this.threadRequest("stepIn") }
  async stepOut(): Promise<void> { await this.threadRequest("stepOut") }

  async restart(): Promise<void> {
    if (!this.transport) return
    if (this.capabilities.supportsRestartRequest === true) {
      await this.transport.connection.request("restart", { arguments: this.config })
      this.state = "running"
      this.invalidateStoppedState()
      this.changed()
      return
    }
    throw new Error("This debug adapter does not support restart")
  }

  async disconnect(terminateDebuggee = this.config.request === "launch"): Promise<void> {
    if (!this.transport || this.state === "terminated") return
    this.state = "terminating"
    this.changed()
    try {
      if (terminateDebuggee && this.capabilities.supportsTerminateRequest === true) {
        await this.transport.connection.request("terminate", {}, 5_000).catch(() => {})
      }
      await this.transport.connection.request("disconnect", { terminateDebuggee }, 5_000).catch(() => {})
    } finally {
      this.finish()
    }
  }

  async selectFrame(frameId: number): Promise<void> {
    const frame = this.frames.find(candidate => candidate.id === frameId)
    if (!frame || !this.transport) return
    this.selectedFrame = frame
    const body = await this.transport.connection.request("scopes", { frameId })
    const scopes = array<DapScope>(body.scopes)
    this.scopes = await Promise.all(scopes.map(async scope => ({
      ...scope,
      variables: await this.variables(scope.variablesReference),
    })))
    this.changed()
  }

  async variables(reference: number, start?: number, count?: number): Promise<DapVariable[]> {
    if (!this.transport || reference <= 0) return []
    const body = await this.transport.connection.request("variables", {
      variablesReference: reference,
      start,
      count,
    })
    return array<DapVariable>(body.variables)
  }

  async evaluate(expression: string, context: "watch" | "repl" | "hover" = "repl"): Promise<{ result: string; variablesReference: number; type?: string }> {
    if (!this.transport) throw new Error("No active DAP connection")
    const body = await this.transport.connection.request("evaluate", {
      expression,
      frameId: this.selectedFrame?.id,
      context,
    })
    return {
      result: String(body.result ?? ""),
      variablesReference: Number(body.variablesReference ?? 0),
      type: typeof body.type === "string" ? body.type : undefined,
    }
  }

  private async threadRequest(command: string, invalidate = true): Promise<void> {
    if (!this.transport) return
    const threadId = this.selectedThreadId ?? this.threads[0]?.id
    if (threadId == null) throw new Error("No debug thread is selected")
    await this.transport.connection.request(command, { threadId })
    if (invalidate) {
      this.state = "running"
      this.invalidateStoppedState()
      this.changed()
    }
  }

  private async handleEvent(event: DapEvent): Promise<void> {
    const body = event.body ?? {}
    switch (event.event) {
      case "initialized":
        this.initializedResolve?.()
        this.initializedResolve = undefined
        break
      case "output":
        this.appendOutput(String(body.category ?? "console"), String(body.output ?? ""))
        break
      case "stopped":
        this.state = "stopped"
        await this.refreshStopped(typeof body.threadId === "number" ? body.threadId : undefined)
        break
      case "continued":
        this.state = "running"
        this.invalidateStoppedState()
        this.changed()
        break
      case "thread":
        await this.refreshThreads().catch(() => {})
        this.changed()
        break
      case "capabilities":
        this.capabilities = { ...this.capabilities, ...(body.capabilities as Record<string, unknown> | undefined) }
        this.changed()
        break
      case "breakpoint": {
        const actual = body.breakpoint as DapBreakpoint | undefined
        if (actual?.source?.path && actual.line) {
          const local = this.hooks.breakpoints().find(item => item.path === actual.source!.path && item.line === actual.line)
          if (local) {
            local.verified = actual.verified
            local.message = actual.message
            this.hooks.breakpointChanged?.(local)
          }
        }
        this.changed()
        break
      }
      case "exited":
        this.appendOutput("console", `Process exited with code ${String(body.exitCode ?? "unknown")}\n`)
        break
      case "terminated":
        this.finish()
        break
    }
  }

  private async handleReverseRequest(request: DapRequest): Promise<void> {
    if (!this.transport) return
    if (request.command === "runInTerminal" && this.hooks.runInTerminal) {
      try {
        const body = await this.hooks.runInTerminal(request.arguments ?? {})
        this.transport.connection.respond(request, body)
      } catch (error) {
        this.transport.connection.respond(request, {}, error instanceof Error ? error : new Error(String(error)))
      }
      return
    }
    this.transport.connection.respond(request, {}, new Error(`Unsupported DAP reverse request: ${request.command}`))
  }

  private async refreshThreads(): Promise<void> {
    if (!this.transport) return
    const body = await this.transport.connection.request("threads")
    this.threads = array<DapThread>(body.threads)
  }

  private async refreshStopped(threadId?: number): Promise<void> {
    const generation = ++this.stoppedGeneration
    await this.refreshThreads()
    if (generation !== this.stoppedGeneration) return
    this.selectedThreadId = threadId ?? this.threads[0]?.id
    if (!this.transport || this.selectedThreadId == null) {
      this.changed()
      return
    }
    const body = await this.transport.connection.request("stackTrace", { threadId: this.selectedThreadId, startFrame: 0, levels: 100 })
    if (generation !== this.stoppedGeneration) return
    this.frames = array<DapStackFrame>(body.stackFrames)
    this.selectedFrame = this.frames[0]
    if (this.selectedFrame) await this.selectFrame(this.selectedFrame.id)
    else this.changed()
  }

  private invalidateStoppedState(): void {
    this.stoppedGeneration++
    this.frames = []
    this.selectedFrame = undefined
    this.scopes = []
  }

  private appendOutput(category: string, text: string): void {
    if (!text) return
    this.output.push({ category, text })
    if (this.output.length > 10_000) this.output.splice(0, this.output.length - 10_000)
    this.changed()
  }

  private fail(message: string): void {
    this.error = message
    this.appendOutput("stderr", `${message}\n`)
    this.finish()
  }

  private finish(): void {
    if (this.state === "terminated") return
    this.state = "terminated"
    this.invalidateStoppedState()
    this.transport?.close()
    this.changed()
  }

  private changed(): void {
    this.hooks.changed(this)
  }
}
