export type WindowsPipePeer = {
  pid: number
  sid: string
  logonSessionId: string
  integrityLevel: string
  remote: boolean
}

export interface WindowsPipeSecurityBackend {
  createCurrentLogonOnlyDacl(): unknown
  verifyPeer(): WindowsPipePeer
}

export function windowsPipeSecurity(
  backend?: WindowsPipeSecurityBackend
): WindowsPipeSecurityBackend {
  if (process.platform !== 'win32') {
    throw new Error('Windows named-pipe security is only available on Windows')
  }
  if (backend === undefined) {
    throw new Error(
      'Windows named-pipe security requires a native DACL and peer-verification backend'
    )
  }
  return backend
}
