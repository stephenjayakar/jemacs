export type DapSessionState = "starting" | "configuring" | "running" | "stopped" | "terminating" | "terminated"

export type DapProtocolMessage = { seq: number; type: "request" | "response" | "event" }
export type DapRequest = DapProtocolMessage & { type: "request"; command: string; arguments?: Record<string, unknown> }
export type DapResponse = DapProtocolMessage & {
  type: "response"
  request_seq: number
  success: boolean
  command: string
  message?: string
  body?: Record<string, unknown>
}
export type DapEvent = DapProtocolMessage & { type: "event"; event: string; body?: Record<string, unknown> }
export type DapMessage = DapRequest | DapResponse | DapEvent

export type DapSource = { name?: string; path?: string; sourceReference?: number }
export type DapThread = { id: number; name: string }
export type DapStackFrame = {
  id: number
  name: string
  source?: DapSource
  line: number
  column: number
  endLine?: number
  endColumn?: number
}
export type DapScope = { name: string; variablesReference: number; expensive: boolean; namedVariables?: number; indexedVariables?: number }
export type DapVariable = {
  name: string
  value: string
  type?: string
  evaluateName?: string
  variablesReference: number
  namedVariables?: number
  indexedVariables?: number
}
export type DapBreakpoint = {
  id?: number
  verified: boolean
  message?: string
  source?: DapSource
  line?: number
  column?: number
}
export type DapCapabilities = Record<string, unknown>

export type JdapPresentation = { hidden?: boolean; group?: string; order?: number }
export type JdapLaunchConfiguration = {
  name: string
  type: string
  request: "launch" | "attach"
  presentation?: JdapPresentation
  preLaunchTask?: string
  postDebugTask?: string
  [key: string]: unknown
}
export type JdapCompoundConfiguration = {
  name: string
  configurations: string[]
  stopAll?: boolean
  presentation?: JdapPresentation
}
export type JdapInputDefinition = {
  id: string
  type: "promptString" | "pickString" | "command"
  description?: string
  default?: string
  password?: boolean
  options?: string[]
  command?: string
  args?: unknown
}
export type LaunchJson = {
  version: "0.2.0"
  configurations: JdapLaunchConfiguration[]
  compounds?: JdapCompoundConfiguration[]
  inputs?: JdapInputDefinition[]
}

export type JdapContext = {
  projectRoot: string
  workspaceFolders: Record<string, string>
  file?: string
  cwd: string
  env: (name: string) => string | undefined
  configValues: Record<string, string>
}

export type JdapTransportDescriptor =
  | { kind: "stdio"; command: string[]; cwd?: string; env?: Record<string, string> }
  | { kind: "tcp"; host: string; port: number; process?: string[]; cwd?: string; env?: Record<string, string> }

export type JdapAdapterDescriptor = {
  types: string[]
  resolve(config: JdapLaunchConfiguration, context: JdapContext): Promise<JdapTransportDescriptor> | JdapTransportDescriptor
}
export type JdapConfigurationProvider = (context: JdapContext) => Promise<JdapLaunchConfiguration[]> | JdapLaunchConfiguration[]
export type JdapCommandVariableResolver = (
  context: JdapContext,
  config: JdapLaunchConfiguration,
  input: JdapInputDefinition,
) => Promise<string> | string
export type JdapTaskProvider = { run(label: string, context: JdapContext): Promise<void> }

export type JdapSourceBreakpoint = {
  id: string
  path: string
  line: number
  enabled: boolean
  condition?: string
  hitCondition?: string
  logMessage?: string
  verified?: boolean
  message?: string
}
