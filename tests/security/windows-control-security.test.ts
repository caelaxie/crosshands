import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CONTRACT_VERSIONS } from '../../packages/contract/src/index.js'
import { decodeFrames, encodeFrame } from '../../packages/runtime/src/index.js'

import {
  encodeWindowsControlRelayRecord,
  verifyWindowsControlRelay,
  WINDOWS_CONTROL_RELAY_RECORD,
  WindowsControlRelayDecoder,
  createWindowsControlServer,
  windowsControlIdentity,
  type WindowsControlConnection,
  type WindowsControlPeer,
  type WindowsControlRelayOptions
} from '../../packages/platform-windows/src/windows-control-security.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  )
})

describe('Windows native control relay protocol', () => {
  it('decodes fragmented binary records without exposing partial input', () => {
    const peer = Buffer.from('{"pid":42}')
    const frame = encodeWindowsControlRelayRecord(WINDOWS_CONTROL_RELAY_RECORD.open, 7n, peer)
    const decoder = new WindowsControlRelayDecoder()

    expect(decoder.push(frame.subarray(0, 9))).toEqual([])
    expect(decoder.push(frame.subarray(9))).toEqual([
      { type: WINDOWS_CONTROL_RELAY_RECORD.open, connectionId: 7n, payload: peer }
    ])
  })

  it('rejects malformed, oversized, and version-mismatched relay records', () => {
    const valid = encodeWindowsControlRelayRecord(WINDOWS_CONTROL_RELAY_RECORD.ready, 0n)
    const badMagic = Buffer.from(valid)
    badMagic.writeUInt32LE(0, 0)
    expect(() => new WindowsControlRelayDecoder().push(badMagic)).toThrow('magic')

    const badVersion = Buffer.from(valid)
    badVersion.writeUInt16LE(2, 4)
    expect(() => new WindowsControlRelayDecoder().push(badVersion)).toThrow('version')

    const oversized = Buffer.from(valid)
    oversized.writeUInt32LE(4 * 1024 * 1024 + 1, 16)
    expect(() => new WindowsControlRelayDecoder().push(oversized)).toThrow('exceeds')
  })

  it('requires an absolute, hash-matched relay payload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosshands-windows-security-'))
    temporaryDirectories.push(directory)
    const helperPath = join(directory, 'crosshands-pipe-relay.exe')
    await writeFile(helperPath, 'unsigned-relay-fixture')
    const { createHash } = await import('node:crypto')
    const helperSha256 = createHash('sha256')
      .update(await readFile(helperPath))
      .digest('hex')
    const base = {
      helperPath,
      helperSha256,
      pipeName: '\\\\.\\pipe\\crosshands-0123456789abcdef01234567',
      onConnection: () => undefined
    }

    await expect(verifyWindowsControlRelay(base)).resolves.toBeUndefined()
    await expect(
      verifyWindowsControlRelay({ ...base, helperSha256: '0'.repeat(64) })
    ).rejects.toThrow('hash mismatch')
    await expect(
      verifyWindowsControlRelay({ ...base, helperPath: 'crosshands-pipe-relay.exe' })
    ).rejects.toThrow('absolute')
  })
})

const verifiedPeer: WindowsControlPeer = {
  pid: 42,
  userSid: 'S-1-5-21-1000',
  logonSid: 'S-1-5-5-1-2',
  logonSessionId: '1:2',
  integrityRid: 8192,
  windowsSessionId: 3,
  processStartedAt: '2026-07-10T00:00:00.000Z',
  executablePath: 'C:\\Program Files\\Agent\\agent.exe',
  remote: false
}

type FakeConnection = WindowsControlConnection & {
  receive(payload: Buffer): void
  output: Buffer[]
}

function fakeConnection(id: bigint): FakeConnection {
  const dataListeners: Array<(payload: Buffer) => void> = []
  const closeListeners: Array<() => void> = []
  const output: Buffer[] = []
  return {
    id,
    peer: verifiedPeer,
    output,
    write: (payload) => output.push(payload),
    close: () => closeListeners.forEach((listener) => listener()),
    onData: (listener) => dataListeners.push(listener),
    onClose: (listener) => closeListeners.push(listener),
    receive: (payload) => dataListeners.forEach((listener) => listener(payload))
  }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
}

describe('Windows relay control server', () => {
  it('never dispatches a request before an identity-bound versioned handshake', async () => {
    let relayOptions: WindowsControlRelayOptions | undefined
    const requests: unknown[] = []
    const server = createWindowsControlServer({
      relay: {
        helperPath: resolve('/unsigned/crosshands-pipe-relay.exe'),
        helperSha256: '0'.repeat(64),
        pipeName: '\\\\.\\pipe\\crosshands-0123456789abcdef01234567'
      },
      identity: windowsControlIdentity(verifiedPeer),
      handler: async (request) => {
        requests.push(request)
        return { ok: true }
      },
      createRelay: (options) => {
        relayOptions = options
        return { start: async () => undefined, close: async () => undefined }
      }
    })
    await server.start()
    const connection = fakeConnection(1n)
    relayOptions!.onConnection(connection)
    connection.receive(
      encodeFrame({ type: 'request', requestId: 'before-handshake', deadlineAt: Date.now() + 1000 })
    )
    await nextTurn()

    expect(requests).toEqual([])
    expect(decodeFrames(Buffer.concat(connection.output))).toContainEqual(
      expect.objectContaining({ code: 'handshake_required' })
    )
  })

  it('binds the claimed identity to the native peer and enforces request deadlines', async () => {
    let relayOptions: WindowsControlRelayOptions | undefined
    const requests: unknown[] = []
    const handshakes: Array<{ accepted: boolean; requestId: string; code?: string }> = []
    const server = createWindowsControlServer({
      relay: {
        helperPath: resolve('/unsigned/crosshands-pipe-relay.exe'),
        helperSha256: '0'.repeat(64),
        pipeName: '\\\\.\\pipe\\crosshands-0123456789abcdef01234567'
      },
      identity: windowsControlIdentity(verifiedPeer),
      handler: async (request) => {
        requests.push(request)
        return { ok: true }
      },
      onHandshake: (event) => handshakes.push(event),
      createRelay: (options) => {
        relayOptions = options
        return { start: async () => undefined, close: async () => undefined }
      }
    })
    await server.start()

    const rejected = fakeConnection(2n)
    relayOptions!.onConnection(rejected)
    rejected.receive(
      encodeFrame({
        type: 'handshake',
        requestId: 'wrong-peer',
        token: '',
        versions: CONTRACT_VERSIONS,
        identity: { osIdentity: 'sid:S-1-5-21-other', graphicalSessionId: 'logon:9:9:session:3' }
      })
    )
    await nextTurn()
    expect(requests).toEqual([])
    expect(decodeFrames(Buffer.concat(rejected.output))).toContainEqual(
      expect.objectContaining({ code: 'peer_rejected' })
    )

    const accepted = fakeConnection(3n)
    relayOptions!.onConnection(accepted)
    accepted.receive(
      Buffer.concat([
        encodeFrame({
          type: 'handshake',
          requestId: 'hello',
          token: '',
          versions: CONTRACT_VERSIONS,
          identity: windowsControlIdentity(verifiedPeer)
        }),
        encodeFrame({
          type: 'request',
          requestId: 'expired',
          deadlineAt: Date.now() - 1,
          payload: { secret: 'must-not-dispatch' }
        }),
        encodeFrame({
          type: 'request',
          requestId: 'fresh',
          deadlineAt: Date.now() + 1_000,
          payload: { operation: 'permissions' }
        })
      ])
    )
    await nextTurn()

    expect(handshakes).toEqual([
      { accepted: false, requestId: 'wrong-peer', code: 'peer_rejected' },
      { accepted: true, requestId: 'hello' }
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ requestId: 'fresh', peer: verifiedPeer })
    expect(decodeFrames(Buffer.concat(accepted.output))).toEqual([
      { type: 'handshake-ok', requestId: 'hello' },
      expect.objectContaining({ type: 'error', requestId: 'expired', code: 'timeout' }),
      { type: 'response', requestId: 'fresh', result: { ok: true } }
    ])
    await server.close()
  })
})

describe('Windows native control relay source', () => {
  it('owns pipe creation and checks every required peer attribute before forwarding bytes', async () => {
    const sourcePath = resolve('native/windows/security/pipe_relay.cpp')
    const source = await readFile(sourcePath, 'utf8')

    for (const required of [
      'CreateNamedPipeW',
      'PIPE_REJECT_REMOTE_CLIENTS',
      'FILE_FLAG_FIRST_PIPE_INSTANCE',
      'ConvertStringSecurityDescriptorToSecurityDescriptorW',
      'SE_GROUP_LOGON_ID',
      'TokenStatistics',
      'TokenIntegrityLevel',
      'GetNamedPipeClientProcessId',
      'GetNamedPipeClientSessionId',
      'ImpersonateNamedPipeClient',
      'OpenThreadToken',
      'QueryFullProcessImageNameW',
      'GetProcessTimes'
    ]) {
      expect(source).toContain(required)
    }

    expect(source.indexOf('inspect_peer(pipe')).toBeLessThan(source.indexOf('send_record(kOpen'))
    expect(source.indexOf('send_record(kOpen')).toBeLessThan(
      source.indexOf('std::thread(client_reader')
    )
  })
})
