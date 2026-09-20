import { randomUUID } from 'node:crypto'

import {
  CONTRACT_VERSIONS,
  createComputerError,
  parseOperationInput,
  type ComputerOperationName,
  type ComputerProvider,
  type ReferenceBindings
} from '@crosshands/contract'
import {
  JsonlDiagnosticsWriter,
  LocalBroker,
  LocalControlServer,
  diagnosticsDirectory,
  emitDiagnostic,
  type BrokerEndpoint,
  type ControlHandshakeEvent,
  type LocalControlIdentity,
  type LocalControlRequest,
  type StableAppIdentity,
  type TargetInspection
} from '@crosshands/runtime'

import { localClientPaths } from './local-client.js'

type ProviderModule = {
  packageVersion: string
  createProvider(): ComputerProvider
  createControlServer?: (options: {
    endpoint: BrokerEndpoint
    identity: LocalControlIdentity
    handler: (request: LocalControlRequest) => Promise<unknown>
    onHandshake?: (event: ControlHandshakeEvent) => void
  }) => Promise<{ start(): Promise<void>; close(): Promise<void> }>
  inspectTarget?: (
    operation: ComputerOperationName,
    input: unknown
  ) => Promise<{ bindings: ReferenceBindings; appIdentity: StableAppIdentity } | null>
}

const PLATFORM_PROVIDER_PACKAGES: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  darwin: '@crosshands/platform-darwin',
  linux: '@crosshands/platform-linux',
  win32: '@crosshands/platform-windows'
}

export function platformProviderPackage(platform: NodeJS.Platform = process.platform): string {
  const packageName = PLATFORM_PROVIDER_PACKAGES[platform]
  if (packageName === undefined) {
    throw new Error(
      `CrossHands has no provider package for ${platform}; run doctor for the supported platform matrix`
    )
  }
  return packageName
}

export async function loadProviderModule(
  platform: NodeJS.Platform = process.platform,
  importer: (specifier: string) => Promise<unknown> = (specifier) => import(specifier)
): Promise<ProviderModule> {
  const packageName = platformProviderPackage(platform)
  let loaded: Partial<ProviderModule>
  try {
    loaded = (await importer(packageName)) as Partial<ProviderModule>
  } catch (cause) {
    throw new Error(
      `The matching CrossHands payload ${packageName}@${CONTRACT_VERSIONS.product} is not installed`,
      { cause }
    )
  }
  if (typeof loaded.createProvider !== 'function')
    throw new Error('CrossHands provider module does not export createProvider()')
  if (loaded.packageVersion !== CONTRACT_VERSIONS.product) {
    throw new Error(
      `CrossHands payload version mismatch: main package is ${CONTRACT_VERSIONS.product}, ${packageName} is ${loaded.packageVersion ?? 'unknown'}`
    )
  }
  return loaded as ProviderModule
}

export async function runBrokerHost(): Promise<void> {
  const providerModule = await loadProviderModule()
  const paths = localClientPaths()
  const peer = { ...paths.identity, verified: true, local: true }
  const generation = `broker-${randomUUID()}`
  const diagnostics = new JsonlDiagnosticsWriter({
    directory: diagnosticsDirectory(paths.identity.graphicalSessionId),
    generation
  })
  const broker = new LocalBroker({
    identity: peer,
    generation,
    providerFactory: () => providerModule.createProvider(),
    diagnostics,
    ...(providerModule.inspectTarget === undefined
      ? {}
      : {
          inspectTarget: (
            operation: ComputerOperationName,
            input: unknown
          ): Promise<TargetInspection | null> => providerModule.inspectTarget!(operation, input)
        })
  })
  try {
    await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    const handler = async ({ payload, deadlineAt }: LocalControlRequest): Promise<unknown> => {
      if (payload === null || typeof payload !== 'object') throw new Error('Invalid broker request')
      const record = payload as Record<string, unknown>
      if (typeof record.operation !== 'string') throw new Error('Missing operation')
      const operation = record.operation as ComputerOperationName
      let input: unknown
      try {
        input = parseOperationInput(operation, record.input)
      } catch (cause) {
        if (cause instanceof Error && cause.name === 'ZodError') {
          throw createComputerError('invalid_argument', 'Invalid input for the selected operation')
        }
        throw cause
      }
      return broker.request({ operation, input, deadlineMs: Math.max(1, deadlineAt - Date.now()) })
    }
    const onHandshake = (event: ControlHandshakeEvent): void => {
      emitDiagnostic(diagnostics, {
        kind: 'client.handshake',
        ...broker.diagnosticEnvelope(),
        accepted: event.accepted,
        requestId: event.requestId,
        ...(event.code === undefined ? {} : { code: event.code })
      })
    }
    const server =
      paths.endpoint.transport === 'named-pipe'
        ? await (providerModule.createControlServer?.({
            endpoint: paths.endpoint,
            identity: paths.identity,
            handler,
            onHandshake
          }) ??
            Promise.reject(
              new Error('The Windows payload has no native DACL and peer-token control relay')
            ))
        : new LocalControlServer({
            endpoint: paths.endpoint,
            runtimeDirectory: paths.runtimeDirectory,
            tokenFile: paths.tokenFile,
            identity: paths.identity,
            handler,
            onHandshake
          })
    await server.start()
    emitDiagnostic(diagnostics, { kind: 'broker.start', ...broker.diagnosticEnvelope() })
    await new Promise<void>((resolve) => {
      const stop = (): void => resolve()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
    await server.close()
  } finally {
    await broker.close('signal')
  }
}
