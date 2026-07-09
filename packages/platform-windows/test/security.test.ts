import { describe, expect, it } from 'vitest'

import {
  requireWindowsPipeSecurityBackend,
  verifyWindowsPipePeer,
  type WindowsNamedPipeSecurityBackend,
  type WindowsPipePeerIdentity
} from '../src/security.js'

function backend(peer: Partial<WindowsPipePeerIdentity> = {}): WindowsNamedPipeSecurityBackend {
  return {
    currentLogonIdentity: () => ({ sid: 'S-1-5-5-1-2', logonSessionId: '1:2', integrityRid: 8192 }),
    createCurrentLogonSidDacl: () => new Uint8Array([1]),
    createServer: () => ({}),
    inspectClient: () => ({
      pid: 42,
      sid: 'S-1-5-5-1-2',
      logonSessionId: '1:2',
      integrityRid: 8192,
      processStartedAt: '2026-07-10T00:00:00.000Z',
      executablePath: 'C:\\Program Files\\CrossHands\\crosshands.exe',
      remote: false,
      ...peer
    }),
    impersonateClient: (_handle, work) => work()
  }
}

describe('Windows named-pipe security seam', () => {
  it('accepts only a complete equal-integrity current-logon local peer', () => {
    expect(verifyWindowsPipePeer(backend(), {})).toMatchObject({ pid: 42, remote: false })
  })

  it.each([
    [{ remote: true }, 'session_unavailable'],
    [{ sid: 'S-1-5-21-other' }, 'session_unavailable'],
    [{ logonSessionId: '9:9' }, 'session_unavailable'],
    [{ integrityRid: 12288 }, 'unsupported_capability'],
    [{ executablePath: '' }, 'session_unavailable']
  ])('rejects an untrusted peer %#', (override, code) => {
    expect(() => verifyWindowsPipePeer(backend(override), {})).toThrowError(
      expect.objectContaining({ code })
    )
  })

  it('does not claim DACL or token verification without a native backend', () => {
    expect(() => requireWindowsPipeSecurityBackend(undefined)).toThrowError(
      expect.objectContaining({ code: 'unsupported_capability' })
    )
  })
})
