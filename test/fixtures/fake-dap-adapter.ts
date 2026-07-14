import { ContentLengthMessageParser, serializeContentLength } from "../../src/protocol/content-length"
import type { DapMessage, DapRequest, DapResponse } from "../../src/dap/types"

const parser = new ContentLengthMessageParser<DapMessage>()
let sequence = 0
let launchRequest: DapRequest | undefined

function send(message: DapMessage): void {
  process.stdout.write(serializeContentLength(message))
}

function respond(request: DapRequest, body: Record<string, unknown> = {}): void {
  const response: DapResponse = {
    seq: ++sequence,
    type: "response",
    request_seq: request.seq,
    success: true,
    command: request.command,
    body,
  }
  send(response)
}

function event(name: string, body: Record<string, unknown> = {}): void {
  send({ seq: ++sequence, type: "event", event: name, body })
}

function handle(request: DapRequest): void {
  switch (request.command) {
    case "initialize":
      respond(request, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true, supportsRestartRequest: true })
      break
    case "launch":
    case "attach":
      launchRequest = request
      event("initialized")
      break
    case "setBreakpoints": {
      const points = Array.isArray(request.arguments?.breakpoints) ? request.arguments.breakpoints as Array<{ line: number }> : []
      respond(request, { breakpoints: points.map(point => ({ verified: true, line: point.line })) })
      break
    }
    case "configurationDone":
      respond(request)
      if (launchRequest) { respond(launchRequest); launchRequest = undefined }
      break
    case "threads":
      respond(request, { threads: [{ id: 1, name: "main" }] })
      break
    case "pause":
      respond(request)
      event("stopped", { reason: "pause", threadId: 1 })
      break
    case "stackTrace":
      respond(request, { stackFrames: [{ id: 10, name: "main", source: { name: "fake.ts", path: "/tmp/fake.ts" }, line: 4, column: 1 }], totalFrames: 1 })
      break
    case "scopes":
      respond(request, { scopes: [{ name: "Locals", variablesReference: 20, expensive: false }] })
      break
    case "variables":
      respond(request, { variables: [{ name: "answer", value: "42", type: "number", variablesReference: 0 }] })
      break
    case "evaluate":
      respond(request, { result: "42", type: "number", variablesReference: 0 })
      break
    case "continue":
    case "next":
    case "stepIn":
    case "stepOut":
      respond(request)
      event("continued", { threadId: 1, allThreadsContinued: true })
      break
    case "restart":
      respond(request)
      break
    case "terminate":
      respond(request)
      break
    case "disconnect":
      respond(request)
      event("terminated")
      setTimeout(() => process.exit(0), 5)
      break
    default:
      respond(request)
  }
}

process.stdin.on("data", chunk => {
  for (const message of parser.feed(new Uint8Array(chunk))) if (message.type === "request") handle(message)
})
