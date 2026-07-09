import { mkdir, readFile, stat } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { CONTRACT_VERSIONS, createComputerError } from '../../packages/contract/src/index.js'
import {
  LocalControlClient,
  LocalControlServer,
  brokerEndpoint,
  encodeFrame,
  type LocalControlServerOptions
} from '../../packages/runtime/src/index.js'

const servers: LocalControlServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function fixture(): Promise<{
  options: LocalControlServerOptions
  tokenFile: string
}> {
  const runtimeDirectory = join(tmpdir(), `ch-${randomUUID().slice(0, 8)}`)
  await mkdir(runtimeDirectory, { mode: 0o700 })
  const identity = { osIdentity: `uid:${process.getuid!()}`, graphicalSessionId: 'test-session' }
  const endpoint = brokerEndpoint({
    platform: process.platform,
    ...identity,
    runtimeDirectory
  })
  return {
    tokenFile: join(runtimeDirectory, 'broker.token'),
    options: {
      endpoint,
      runtimeDirectory,
      identity,
      tokenFile: join(runtimeDirectory, 'broker.token'),
      maxFrameBytes: 2048,
      handler: async (request) => ({ echoed: request.payload })
    }
  }
}

function rawExchange(address: string, frame: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address)
    const chunks: Buffer[] = []
    socket.on('connect', () => socket.write(encodeFrame(frame, 4096)))
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('close', () => {
      if (chunks.length === 0) return resolve(undefined)
      const data = Buffer.concat(chunks)
      const length = data.readUInt32BE(0)
      resolve(JSON.parse(data.subarray(4, 4 + length).toString('utf8')))
    })
  })
}

describe('local control transport', () => {
  it('rejects requests before handshake', async () => {
    const { options } = await fixture()
    const server = new LocalControlServer(options)
    servers.push(server)
    await server.start()

    await expect(
      rawExchange(options.endpoint.address, {
        type: 'request',
        requestId: 'r1',
        deadlineAt: Date.now() + 1_000,
        payload: {}
      })
    ).resolves.toMatchObject({ type: 'error', code: 'handshake_required' })
    expect(server.requestCount).toBe(0)
  })

  it('rejects a bad broker token and incompatible version before handling requests', async () => {
    const { options, tokenFile } = await fixture()
    const server = new LocalControlServer(options)
    servers.push(server)
    await server.start()
    const token = await readFile(tokenFile, 'utf8')

    await expect(
      rawExchange(options.endpoint.address, {
        type: 'handshake',
        requestId: 'h1',
        token: `${token}bad`,
        versions: CONTRACT_VERSIONS,
        identity: options.identity
      })
    ).resolves.toMatchObject({ type: 'error', code: 'peer_rejected' })
    await expect(
      rawExchange(options.endpoint.address, {
        type: 'handshake',
        requestId: 'h2',
        token,
        versions: { ...CONTRACT_VERSIONS, brokerControl: 99 },
        identity: options.identity
      })
    ).resolves.toMatchObject({ type: 'error', code: 'version_incompatible' })
    expect(server.requestCount).toBe(0)
  })

  it('serves a handshaken request with reserved IDs and restrictive files', async () => {
    const { options, tokenFile } = await fixture()
    const server = new LocalControlServer(options)
    servers.push(server)
    await server.start()
    const client = await LocalControlClient.connect({
      endpoint: options.endpoint,
      token: (await readFile(tokenFile, 'utf8')).trim(),
      versions: CONTRACT_VERSIONS,
      identity: options.identity,
      maxFrameBytes: 2048
    })

    await expect(client.request({ hello: 'world' }, { deadlineMs: 1_000 })).resolves.toEqual({
      echoed: { hello: 'world' }
    })
    await expect(client.request({ late: true }, { deadlineMs: -1 })).rejects.toMatchObject({
      code: 'timeout'
    })
    expect(server.requestCount).toBe(1)
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600)
    expect((await stat(options.endpoint.address)).mode & 0o777).toBe(0o600)
    await client.close()
  })

  it('expires an unresponsive client request and remains usable for later responses', async () => {
    const { options, tokenFile } = await fixture()
    let requests = 0
    options.handler = async (request) => {
      requests += 1
      await new Promise<void>((resolve) => setTimeout(resolve, requests === 1 ? 200 : 0))
      return { echoed: request.payload }
    }
    const server = new LocalControlServer(options)
    servers.push(server)
    await server.start()
    const client = await LocalControlClient.connect({
      endpoint: options.endpoint,
      token: (await readFile(tokenFile, 'utf8')).trim(),
      versions: CONTRACT_VERSIONS,
      identity: options.identity,
      maxFrameBytes: 2048
    })

    await expect(client.request({ slow: true }, { deadlineMs: 5 })).rejects.toMatchObject({
      code: 'timeout'
    })
    await expect(client.request({ next: true }, { deadlineMs: 1_000 })).resolves.toEqual({
      echoed: { next: true }
    })
    await client.close()
  })

  it('preserves actionable broker error metadata through control IPC', async () => {
    const { options, tokenFile } = await fixture()
    options.handler = async () => {
      throw createComputerError('stale_target', 'Refresh the observed target', {
        snapshotId: 'snapshot-1'
      })
    }
    const server = new LocalControlServer(options)
    servers.push(server)
    await server.start()
    const client = await LocalControlClient.connect({
      endpoint: options.endpoint,
      token: (await readFile(tokenFile, 'utf8')).trim(),
      versions: CONTRACT_VERSIONS,
      identity: options.identity,
      maxFrameBytes: 2048
    })

    await expect(client.request({}, { deadlineMs: 1_000 })).rejects.toMatchObject({
      code: 'stale_target',
      retry: true,
      remediation: 'refresh_state',
      details: { snapshotId: 'snapshot-1' }
    })
    await client.close()
  })

  it('rejects malformed and oversized frames without dispatch and closes cleanly', async () => {
    const { options } = await fixture()
    const server = new LocalControlServer(options)
    servers.push(server)
    await server.start()

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(options.endpoint.address)
      socket.on('connect', () => socket.write(Buffer.from([0, 0, 32, 0])))
      socket.on('error', reject)
      socket.on('close', () => resolve())
    })
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(options.endpoint.address)
      socket.on('connect', () => socket.write(Buffer.from([0, 0, 0, 1, 0x7b])))
      socket.on('error', reject)
      socket.on('close', () => resolve())
    })
    expect(server.requestCount).toBe(0)
    await server.close()
    await expect(
      LocalControlClient.connect({
        endpoint: options.endpoint,
        token: 'unreachable',
        versions: CONTRACT_VERSIONS,
        identity: options.identity
      })
    ).rejects.toThrow()
  })
})
