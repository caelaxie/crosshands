import { pathToFileURL } from 'node:url'

import {
  CONTRACT_VERSIONS,
  parseOperationInput,
  type ComputerOperationName,
  type ComputerProvider,
  type ReferenceBindings
} from '@crosshands/contract'
import {
  LocalBroker,
  LocalControlServer,
  type StableAppIdentity,
  type TargetInspection
} from '@crosshands/runtime'

import { localClientPaths } from './local-client.js'

type ProviderModule = {
  createProvider(): ComputerProvider
  inspectTarget?: (
    operation: ComputerOperationName,
    input: unknown
  ) => Promise<{ bindings: ReferenceBindings; appIdentity: StableAppIdentity } | null>
}

async function loadProviderModule(): Promise<ProviderModule> {
  const path = process.env.CROSSHANDS_PROVIDER_MODULE
  if (path === undefined) {
    throw new Error(
      'No CrossHands platform provider is installed; install the matching platform payload and run doctor'
    )
  }
  const loaded = (await import(
    path.startsWith('file:') ? path : pathToFileURL(path).href
  )) as Partial<ProviderModule>
  if (typeof loaded.createProvider !== 'function')
    throw new Error('CrossHands provider module does not export createProvider()')
  return loaded as ProviderModule
}

export async function runBrokerHost(): Promise<void> {
  const providerModule = await loadProviderModule()
  const paths = localClientPaths()
  const peer = { ...paths.identity, verified: true, local: true }
  const broker = new LocalBroker({
    identity: peer,
    providerFactory: () => providerModule.createProvider(),
    ...(providerModule.inspectTarget === undefined
      ? {}
      : {
          inspectTarget: (
            operation: ComputerOperationName,
            input: unknown
          ): Promise<TargetInspection | null> => providerModule.inspectTarget!(operation, input)
        })
  })
  await broker.connect({ peer, versions: CONTRACT_VERSIONS })
  const server = new LocalControlServer({
    endpoint: paths.endpoint,
    runtimeDirectory: paths.runtimeDirectory,
    tokenFile: paths.tokenFile,
    identity: paths.identity,
    handler: async ({ payload, deadlineAt }) => {
      if (payload === null || typeof payload !== 'object') throw new Error('Invalid broker request')
      const record = payload as Record<string, unknown>
      if (typeof record.operation !== 'string') throw new Error('Missing operation')
      const operation = record.operation as ComputerOperationName
      const input = parseOperationInput(operation, record.input)
      return broker.request({ operation, input, deadlineMs: Math.max(1, deadlineAt - Date.now()) })
    }
  })
  await server.start()
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  await server.close()
}
