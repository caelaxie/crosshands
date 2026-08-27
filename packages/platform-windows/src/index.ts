import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  CONTRACT_VERSIONS,
  type ComputerOperationName,
  type ReferenceBindings
} from '@crosshands/contract'
import type {
  BrokerEndpoint,
  LocalControlIdentity,
  LocalControlRequest,
  StableAppIdentity
} from '@crosshands/runtime'

import { WindowsComputerProvider } from './provider.js'
import {
  createWindowsControlServer as createWindowsRelayControlServer,
  type WindowsRelayControlServer
} from './windows-control-security.js'

export const packageVersion = CONTRACT_VERSIONS.product

export * from './provider.js'
export * from './security.js'
export * from './windows-control-security.js'

const PAYLOAD_MANIFEST = fileURLToPath(new URL('../assets/payload.json', import.meta.url))
const CONTROL_RELAY = fileURLToPath(new URL('../assets/crosshands-pipe-relay.exe', import.meta.url))

type PlatformControlServerOptions = {
  endpoint: BrokerEndpoint
  identity: LocalControlIdentity
  handler: (request: LocalControlRequest) => Promise<unknown>
}

export async function createControlServer(
  options: PlatformControlServerOptions
): Promise<WindowsRelayControlServer> {
  if (options.endpoint.transport !== 'named-pipe') {
    throw new Error('Windows control relay requires a named-pipe endpoint')
  }
  const manifest = JSON.parse(await readFile(PAYLOAD_MANIFEST, 'utf8')) as {
    files?: Record<string, unknown>
  }
  const helperSha256 = manifest.files?.['crosshands-pipe-relay.exe']
  if (typeof helperSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(helperSha256)) {
    throw new Error('Windows control relay is missing payload hash metadata')
  }
  return createWindowsRelayControlServer({
    identity: options.identity,
    relay: {
      helperPath: CONTROL_RELAY,
      helperSha256,
      pipeName: options.endpoint.address
    },
    handler: options.handler
  })
}

let sharedProvider: WindowsComputerProvider | undefined

export function createProvider(): WindowsComputerProvider {
  sharedProvider = new WindowsComputerProvider()
  return sharedProvider
}

export async function inspectTarget(
  operation: ComputerOperationName,
  input: unknown
): Promise<{ bindings: ReferenceBindings; appIdentity: StableAppIdentity } | null> {
  if (sharedProvider === undefined) {
    throw new Error('createProvider() must be called before inspectTarget()')
  }
  return sharedProvider.inspect(operation, input)
}
