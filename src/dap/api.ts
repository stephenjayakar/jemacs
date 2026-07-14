import type {
  JdapAdapterDescriptor,
  JdapCommandVariableResolver,
  JdapConfigurationProvider,
  JdapTaskProvider,
} from "./types"

const adapters = new Map<string, JdapAdapterDescriptor>()
const configurationProviders = new Set<JdapConfigurationProvider>()
const commandVariables = new Map<string, JdapCommandVariableResolver>()
let taskProvider: JdapTaskProvider | null = null

export function registerJdapAdapter(descriptor: JdapAdapterDescriptor): () => void {
  for (const type of descriptor.types) adapters.set(type, descriptor)
  return () => {
    for (const type of descriptor.types) if (adapters.get(type) === descriptor) adapters.delete(type)
  }
}

export function jdapAdapter(type: string): JdapAdapterDescriptor | undefined {
  return adapters.get(type)
}

export function registerJdapConfigurationProvider(provider: JdapConfigurationProvider): () => void {
  configurationProviders.add(provider)
  return () => configurationProviders.delete(provider)
}

export function listJdapConfigurationProviders(): JdapConfigurationProvider[] {
  return [...configurationProviders]
}

export function registerJdapCommandVariable(name: string, resolver: JdapCommandVariableResolver): () => void {
  commandVariables.set(name, resolver)
  return () => { if (commandVariables.get(name) === resolver) commandVariables.delete(name) }
}

export function jdapCommandVariable(name: string): JdapCommandVariableResolver | undefined {
  return commandVariables.get(name)
}

export function registerJdapTaskProvider(provider: JdapTaskProvider): () => void {
  const previous = taskProvider
  taskProvider = provider
  return () => { if (taskProvider === provider) taskProvider = previous }
}

export function jdapTaskProvider(): JdapTaskProvider | null {
  return taskProvider
}
