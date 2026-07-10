import { createComputerError } from '@crosshands/contract'

export type WindowsLogonIdentity = {
  sid: string
  logonSessionId: string
  integrityRid: number
}

export type WindowsPipePeerIdentity = WindowsLogonIdentity & {
  pid: number
  processStartedAt: string
  executablePath: string
  remote: boolean
}

/**
 * This interface is deliberately native-backed. Node's named-pipe API cannot
 * prove the peer token or construct the required logon-SID-only DACL.
 */
export interface WindowsNamedPipeSecurityBackend {
  currentLogonIdentity(): WindowsLogonIdentity
  createCurrentLogonSidDacl(logonSid: string): Uint8Array
  createServer(pipeName: string, securityDescriptor: Uint8Array): unknown
  inspectClient(serverHandle: unknown): WindowsPipePeerIdentity
  impersonateClient<T>(serverHandle: unknown, work: () => T): T
}

export function verifyWindowsPipePeer(
  backend: WindowsNamedPipeSecurityBackend,
  serverHandle: unknown
): WindowsPipePeerIdentity {
  const expected = backend.currentLogonIdentity()
  return backend.impersonateClient(serverHandle, () => {
    const peer = backend.inspectClient(serverHandle)
    if (peer.remote) {
      throw createComputerError('session_unavailable', 'Remote named-pipe clients are rejected')
    }
    if (peer.sid !== expected.sid || peer.logonSessionId !== expected.logonSessionId) {
      throw createComputerError(
        'session_unavailable',
        'Named-pipe client belongs to another logon identity or session'
      )
    }
    if (peer.integrityRid !== expected.integrityRid) {
      throw createComputerError(
        'unsupported_capability',
        'Named-pipe client integrity differs from the broker'
      )
    }
    if (peer.pid <= 0 || peer.executablePath.length === 0 || peer.processStartedAt.length === 0) {
      throw createComputerError('session_unavailable', 'Named-pipe client identity is incomplete')
    }
    return peer
  })
}

export function requireWindowsPipeSecurityBackend(
  backend: WindowsNamedPipeSecurityBackend | undefined
): WindowsNamedPipeSecurityBackend {
  if (backend === undefined) {
    throw createComputerError(
      'unsupported_capability',
      'The installed Windows payload has no native named-pipe DACL and peer-token verifier'
    )
  }
  return backend
}
