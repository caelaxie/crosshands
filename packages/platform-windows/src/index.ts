import type { ComputerOperationName, ReferenceBindings } from '@crosshands/contract'
import type { StableAppIdentity } from '@crosshands/runtime'

import { WindowsComputerProvider } from './provider.js'

export * from './provider.js'
export * from './security.js'

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
