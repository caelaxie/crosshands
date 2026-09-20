import { createHash } from 'node:crypto'
import { join } from 'node:path'

export type BrokerEndpoint =
  | { transport: 'unix'; address: string }
  | { transport: 'named-pipe'; address: string }

export type BrokerEndpointOptions = {
  platform: NodeJS.Platform
  osIdentity: string
  graphicalSessionId: string
  runtimeDirectory?: string
}

export function graphicalSessionKey(graphicalSessionId: string): string {
  return createHash('sha256').update(graphicalSessionId).digest('hex').slice(0, 12)
}

export function brokerEndpoint(options: BrokerEndpointOptions): BrokerEndpoint {
  const key = createHash('sha256')
    .update(`${options.osIdentity}\0${options.graphicalSessionId}`)
    .digest('hex')
    .slice(0, 24)
  if (options.platform === 'win32') {
    return { transport: 'named-pipe', address: `\\\\.\\pipe\\crosshands-${key}` }
  }
  if (options.runtimeDirectory === undefined) {
    throw new Error('A private runtime directory is required for Unix IPC')
  }
  return { transport: 'unix', address: join(options.runtimeDirectory, `${key}.sock`) }
}
