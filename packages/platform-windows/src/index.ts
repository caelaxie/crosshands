import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type { ComputerOperationName, ReferenceBindings } from '@crosshands/contract'
import type {
  BrokerEndpoint,
  LocalControlIdentity,
  LocalControlRequest,
  StableAppIdentity
} from '@crosshands/runtime'

import { verifyWindowsAuthenticode, WindowsComputerProvider } from './provider.js'
import {
  createWindowsControlServer as createWindowsRelayControlServer,
  type WindowsRelayControlServer
} from './windows-control-security.js'

export const packageVersion = '0.1.0'

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
    authenticode?: {
      required: boolean
      publisher?: string
      thumbprint?: string
      timestampRequired?: boolean
    }
  }
  const helperSha256 = manifest.files?.['crosshands-pipe-relay.exe']
  const policy = manifest.authenticode
  if (
    typeof helperSha256 !== 'string' ||
    policy?.required !== true ||
    typeof policy.publisher !== 'string' ||
    typeof policy.thumbprint !== 'string' ||
    !/^[a-f0-9]{40,64}$/i.test(policy.thumbprint)
  ) {
    throw new Error('Windows control relay is missing signed release metadata')
  }
  return createWindowsRelayControlServer({
    identity: options.identity,
    relay: {
      helperPath: CONTROL_RELAY,
      helperSha256,
      expectedPublisher: policy.publisher,
      expectedThumbprint: policy.thumbprint,
      pipeName: options.endpoint.address,
      verifyAuthenticode: async (helperPath) => {
        const evidence = await verifyWindowsAuthenticode(helperPath, policy)
        return {
          trusted: evidence.trusted,
          publisher: evidence.publisher,
          thumbprint: evidence.thumbprint
        }
      }
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
