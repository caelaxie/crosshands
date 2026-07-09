import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, open, rename, unlink } from 'node:fs/promises'
import net, { type Socket } from 'node:net'

import {
  createComputerError,
  negotiateVersionHandshake,
  type ContractVersions
} from '@crosshands/contract'

import type { BrokerEndpoint } from './endpoint.js'
import { DEFAULT_MAX_CONTROL_MESSAGE_BYTES, encodeFrame } from './framing.js'
import { acquireUnixLease, validateUnixRuntimeDirectory, type UnixLease } from './unix.js'
import {
  windowsPipeSecurity,
  type WindowsPipeSecurityBackend,
  type WindowsPipePeer
} from './windows.js'

export type LocalControlIdentity = {
  osIdentity: string
  graphicalSessionId: string
}

export type LocalControlHandshake = {
  type: 'handshake'
  requestId: string
  token: string
  versions: ContractVersions
  identity: LocalControlIdentity
}

export interface LocalPeerAuthenticator {
  authenticate(handshake: LocalControlHandshake, socket: Socket): Promise<boolean>
}

export type LocalControlRequest = {
  requestId: string
  payload: unknown
  deadlineAt: number
}

export type LocalControlServerOptions = {
  endpoint: BrokerEndpoint
  runtimeDirectory?: string
  tokenFile?: string
  identity: LocalControlIdentity
  handler: (request: LocalControlRequest) => Promise<unknown>
  authenticator?: LocalPeerAuthenticator
  windowsSecurity?: WindowsPipeSecurityBackend
  maxFrameBytes?: number
  maxFramesPerConnection?: number
  now?: () => number
}

type ControlMessage = Record<string, unknown> & { type: string; requestId?: string }

class StreamingFrameDecoder {
  readonly #maxBytes: number
  #buffer = Buffer.alloc(0)

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes
  }

  push(chunk: Buffer): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    const frames: unknown[] = []
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readUInt32BE(0)
      if (length > this.#maxBytes) throw new RangeError('Frame exceeds maximum message size')
      if (this.#buffer.byteLength < 4 + length) break
      const payload = this.#buffer.subarray(4, 4 + length)
      this.#buffer = this.#buffer.subarray(4 + length)
      try {
        frames.push(JSON.parse(payload.toString('utf8')) as unknown)
      } catch {
        throw new Error('Malformed JSON frame')
      }
    }
    return frames
  }
}

function sameIdentity(a: LocalControlIdentity, b: LocalControlIdentity): boolean {
  return a.osIdentity === b.osIdentity && a.graphicalSessionId === b.graphicalSessionId
}

function safeTokenEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

async function writeAtomicToken(path: string, token: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${token}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  await chmod(path, 0o600)
}

function errorMessage(requestId: string | undefined, code: string, message: string): object {
  return { type: 'error', requestId: requestId ?? '', code, message }
}

export class LocalControlServer {
  readonly #options: LocalControlServerOptions
  readonly #maxFrameBytes: number
  readonly #maxFrames: number
  readonly #now: () => number
  readonly #sockets = new Set<Socket>()
  #server: net.Server | undefined
  #lease: UnixLease | undefined
  #token = ''
  #requestCount = 0

  constructor(options: LocalControlServerOptions) {
    this.#options = options
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_CONTROL_MESSAGE_BYTES
    this.#maxFrames = options.maxFramesPerConnection ?? 1024
    this.#now = options.now ?? Date.now
  }

  get requestCount(): number {
    return this.#requestCount
  }

  async start(): Promise<void> {
    if (this.#server !== undefined) return
    if (this.#options.endpoint.transport === 'unix') {
      const runtimeDirectory = this.#options.runtimeDirectory
      const tokenFile = this.#options.tokenFile
      const uid = process.getuid?.()
      if (runtimeDirectory === undefined || tokenFile === undefined || uid === undefined) {
        throw new Error(
          'Unix control transport requires a private runtime directory and token file'
        )
      }
      await validateUnixRuntimeDirectory(runtimeDirectory, { uid, stopAt: runtimeDirectory })
      this.#lease = await acquireUnixLease({
        runtimeDirectory,
        endpoint: this.#options.endpoint.address,
        owner: `${this.#options.identity.osIdentity}:${this.#options.identity.graphicalSessionId}`,
        isProcessAlive: (pid) => {
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        }
      })
      this.#token = randomBytes(32).toString('base64url')
      await writeAtomicToken(tokenFile, this.#token)
    } else {
      const backend = windowsPipeSecurity(this.#options.windowsSecurity)
      backend.createCurrentLogonOnlyDacl()
    }

    const server = net.createServer((socket) => this.#accept(socket))
    this.#server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.#options.endpoint.address, () => {
          server.off('error', reject)
          resolve()
        })
      })
      if (this.#options.endpoint.transport === 'unix') {
        await chmod(this.#options.endpoint.address, 0o600)
      }
    } catch (cause) {
      await this.close()
      throw cause
    }
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket)
    const decoder = new StreamingFrameDecoder(this.#maxFrameBytes)
    let authenticated = false
    let frameCount = 0
    let chain = Promise.resolve()
    socket.on('close', () => this.#sockets.delete(socket))
    socket.on('error', () => undefined)
    socket.on('data', (chunk: Buffer) => {
      chain = chain
        .then(async () => {
          for (const raw of decoder.push(chunk)) {
            frameCount += 1
            if (frameCount > this.#maxFrames) throw new Error('Connection frame limit exceeded')
            if (raw === null || typeof raw !== 'object' || !('type' in raw)) {
              throw new Error('Malformed control message')
            }
            const message = raw as ControlMessage
            if (!authenticated) {
              if (message.type !== 'handshake') {
                this.#sendAndClose(
                  socket,
                  errorMessage(message.requestId, 'handshake_required', 'Handshake is required')
                )
                return
              }
              // oxlint-disable-next-line no-await-in-loop -- frames on one connection are ordered.
              authenticated = await this.#authenticate(message, socket)
              if (!authenticated) return
              this.#send(socket, { type: 'handshake-ok', requestId: message.requestId })
              continue
            }
            if (message.type !== 'request') {
              this.#sendAndClose(
                socket,
                errorMessage(message.requestId, 'invalid_message', 'Expected a request message')
              )
              return
            }
            // oxlint-disable-next-line no-await-in-loop -- responses preserve request frame order.
            await this.#handleRequest(socket, message)
          }
        })
        .catch(() => {
          socket.destroy()
        })
    })
  }

  async #authenticate(message: ControlMessage, socket: Socket): Promise<boolean> {
    const handshake = message as unknown as LocalControlHandshake
    if (
      typeof handshake.requestId !== 'string' ||
      typeof handshake.token !== 'string' ||
      handshake.identity === null ||
      typeof handshake.identity !== 'object' ||
      !sameIdentity(handshake.identity, this.#options.identity)
    ) {
      this.#sendAndClose(
        socket,
        errorMessage(handshake.requestId, 'peer_rejected', 'Peer identity was rejected')
      )
      return false
    }
    const versions = negotiateVersionHandshake(handshake.versions)
    if (!versions.ok) {
      this.#sendAndClose(
        socket,
        errorMessage(handshake.requestId, versions.error.code, versions.error.message)
      )
      return false
    }
    let accepted: boolean
    if (this.#options.authenticator !== undefined) {
      accepted = await this.#options.authenticator.authenticate(handshake, socket)
    } else if (this.#options.endpoint.transport === 'unix') {
      accepted = safeTokenEqual(handshake.token, this.#token)
    } else {
      const peer: WindowsPipePeer = this.#options.windowsSecurity!.verifyPeer()
      accepted =
        !peer.remote &&
        peer.sid === this.#options.identity.osIdentity &&
        peer.logonSessionId === this.#options.identity.graphicalSessionId
    }
    if (!accepted) {
      this.#sendAndClose(
        socket,
        errorMessage(handshake.requestId, 'peer_rejected', 'Peer authentication failed')
      )
    }
    return accepted
  }

  async #handleRequest(socket: Socket, message: ControlMessage): Promise<void> {
    if (
      typeof message.requestId !== 'string' ||
      typeof message.deadlineAt !== 'number' ||
      !Number.isFinite(message.deadlineAt)
    ) {
      this.#sendAndClose(
        socket,
        errorMessage(message.requestId, 'invalid_request', 'Request ID and deadline are required')
      )
      return
    }
    if (message.deadlineAt <= this.#now()) {
      this.#send(socket, errorMessage(message.requestId, 'timeout', 'Request deadline elapsed'))
      return
    }
    this.#requestCount += 1
    const request: LocalControlRequest = {
      requestId: message.requestId,
      payload: message.payload,
      deadlineAt: message.deadlineAt
    }
    let timer: NodeJS.Timeout | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(createComputerError('timeout', 'Control request deadline elapsed')),
          (message.deadlineAt as number) - this.#now()
        )
        timer.unref()
      })
      const result = await Promise.race([this.#options.handler(request), timeout])
      this.#send(socket, { type: 'response', requestId: message.requestId, result })
    } catch (cause) {
      const code =
        typeof cause === 'object' && cause !== null && 'code' in cause
          ? String(cause.code)
          : 'request_failed'
      this.#send(
        socket,
        errorMessage(
          message.requestId,
          code,
          cause instanceof Error ? cause.message : 'Request failed'
        )
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  #send(socket: Socket, message: unknown): void {
    socket.write(encodeFrame(message, this.#maxFrameBytes))
  }

  #sendAndClose(socket: Socket, message: unknown): void {
    socket.end(encodeFrame(message, this.#maxFrameBytes))
  }

  async close(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (this.#options.endpoint.transport === 'unix') {
      await unlink(this.#options.endpoint.address).catch(() => undefined)
      if (this.#options.tokenFile !== undefined) {
        await unlink(this.#options.tokenFile).catch(() => undefined)
      }
    }
    await this.#lease?.release()
    this.#lease = undefined
    this.#token = ''
  }
}

export type LocalControlClientOptions = {
  endpoint: BrokerEndpoint
  token: string
  versions: ContractVersions
  identity: LocalControlIdentity
  maxFrameBytes?: number
}

export class LocalControlClient {
  readonly #socket: Socket
  readonly #maxFrameBytes: number
  readonly #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >()
  #sequence = 0

  private constructor(socket: Socket, maxFrameBytes: number) {
    this.#socket = socket
    this.#maxFrameBytes = maxFrameBytes
    const decoder = new StreamingFrameDecoder(maxFrameBytes)
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const raw of decoder.push(chunk)) this.#receive(raw)
      } catch (cause) {
        this.#failAll(cause)
        socket.destroy()
      }
    })
    socket.on('error', (cause) => this.#failAll(cause))
    socket.on('close', () => this.#failAll(new Error('Control connection closed')))
  }

  static async connect(options: LocalControlClientOptions): Promise<LocalControlClient> {
    const socket = net.createConnection(options.endpoint.address)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const client = new LocalControlClient(
      socket,
      options.maxFrameBytes ?? DEFAULT_MAX_CONTROL_MESSAGE_BYTES
    )
    const requestId = `handshake-${randomUUID()}`
    const response = client.#roundTrip(requestId, {
      type: 'handshake',
      requestId,
      token: options.token,
      versions: options.versions,
      identity: options.identity
    })
    await response
    return client
  }

  request(payload: unknown, options: { deadlineMs: number }): Promise<unknown> {
    const requestId = `request-${++this.#sequence}`
    return this.#roundTrip(requestId, {
      type: 'request',
      requestId,
      deadlineAt: Date.now() + options.deadlineMs,
      payload
    })
  }

  #roundTrip(requestId: string, message: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject })
      this.#socket.write(encodeFrame(message, this.#maxFrameBytes), (cause) => {
        if (cause !== null && cause !== undefined) {
          this.#pending.delete(requestId)
          reject(cause)
        }
      })
    })
  }

  #receive(raw: unknown): void {
    if (raw === null || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>
    if (typeof message.requestId !== 'string') return
    const pending = this.#pending.get(message.requestId)
    if (pending === undefined) return
    this.#pending.delete(message.requestId)
    if (message.type === 'error') {
      pending.reject(Object.assign(new Error(String(message.message)), { code: message.code }))
    } else if (message.type === 'response') {
      pending.resolve(message.result)
    } else if (message.type === 'handshake-ok') {
      pending.resolve(undefined)
    } else {
      pending.reject(new Error('Unexpected control response'))
    }
  }

  #failAll(cause: unknown): void {
    for (const pending of this.#pending.values()) pending.reject(cause)
    this.#pending.clear()
  }

  async close(): Promise<void> {
    if (this.#socket.destroyed) return
    await new Promise<void>((resolve) => this.#socket.end(resolve))
  }
}
