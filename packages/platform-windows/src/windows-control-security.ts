import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { negotiateVersionHandshake, type ContractVersions } from '@crosshands/contract'
import {
  DEFAULT_MAX_CONTROL_MESSAGE_BYTES,
  encodeFrame,
  type ControlHandshakeEvent
} from '@crosshands/runtime'

const RELAY_MAGIC = 0x53504858
const RELAY_VERSION = 1
const HEADER_BYTES = 20
const MAX_RELAY_PAYLOAD_BYTES = 4 * 1024 * 1024

export const WINDOWS_CONTROL_RELAY_RECORD = {
  open: 1,
  data: 2,
  close: 3,
  error: 4,
  ready: 5,
  shutdown: 6
} as const

export type WindowsControlPeer = {
  pid: number
  userSid: string
  logonSid: string
  logonSessionId: string
  integrityRid: number
  windowsSessionId: number
  processStartedAt: string
  executablePath: string
  remote: false
}

export type WindowsControlIdentity = {
  osIdentity: string
  graphicalSessionId: string
}

export function windowsControlIdentity(peer: WindowsControlPeer): WindowsControlIdentity {
  return {
    osIdentity: `sid:${peer.userSid}`,
    graphicalSessionId: `logon:${peer.logonSessionId}:session:${peer.windowsSessionId}`
  }
}

export type WindowsControlRelayRecord = {
  type: number
  connectionId: bigint
  payload: Buffer
}

export class WindowsControlRelayDecoder {
  #buffer = Buffer.alloc(0)

  push(chunk: Buffer): WindowsControlRelayRecord[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    const records: WindowsControlRelayRecord[] = []
    while (this.#buffer.byteLength >= HEADER_BYTES) {
      if (this.#buffer.readUInt32LE(0) !== RELAY_MAGIC) throw new Error('Invalid relay magic')
      if (this.#buffer.readUInt16LE(4) !== RELAY_VERSION) throw new Error('Invalid relay version')
      const length = this.#buffer.readUInt32LE(16)
      if (length > MAX_RELAY_PAYLOAD_BYTES) throw new Error('Relay payload exceeds limit')
      if (this.#buffer.byteLength < HEADER_BYTES + length) break
      records.push({
        type: this.#buffer.readUInt16LE(6),
        connectionId: this.#buffer.readBigUInt64LE(8),
        payload: this.#buffer.subarray(HEADER_BYTES, HEADER_BYTES + length)
      })
      this.#buffer = this.#buffer.subarray(HEADER_BYTES + length)
    }
    return records
  }
}

export function encodeWindowsControlRelayRecord(
  type: number,
  connectionId: bigint,
  payload: Buffer = Buffer.alloc(0)
): Buffer {
  if (payload.byteLength > MAX_RELAY_PAYLOAD_BYTES) throw new Error('Relay payload exceeds limit')
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.byteLength)
  frame.writeUInt32LE(RELAY_MAGIC, 0)
  frame.writeUInt16LE(RELAY_VERSION, 4)
  frame.writeUInt16LE(type, 6)
  frame.writeBigUInt64LE(connectionId, 8)
  frame.writeUInt32LE(payload.byteLength, 16)
  payload.copy(frame, HEADER_BYTES)
  return frame
}

export type WindowsControlRelayOptions = {
  helperPath: string
  helperSha256: string
  pipeName: string
  onConnection: (connection: WindowsControlConnection) => void
  spawnProcess?: typeof spawn
}

export type WindowsRelayControlRequest = {
  requestId: string
  payload: unknown
  deadlineAt: number
  peer: WindowsControlPeer
}

export type WindowsRelayControlServerOptions = {
  relay: Omit<WindowsControlRelayOptions, 'onConnection'>
  identity: WindowsControlIdentity
  handler: (request: WindowsRelayControlRequest) => Promise<unknown>
  createRelay?: (options: WindowsControlRelayOptions) => WindowsControlRelay
  maxFrameBytes?: number
  maxFramesPerConnection?: number
  now?: () => number
  onHandshake?: (event: ControlHandshakeEvent) => void
}

export interface WindowsControlRelay {
  start(): Promise<void>
  close(): Promise<void>
}

export type WindowsControlConnection = {
  id: bigint
  peer: WindowsControlPeer
  write(payload: Buffer): void
  close(): void
  onData(listener: (payload: Buffer) => void): void
  onClose(listener: () => void): void
}

function parsePeer(payload: Buffer): WindowsControlPeer {
  const raw = JSON.parse(payload.toString('utf8')) as Partial<WindowsControlPeer>
  if (
    !Number.isSafeInteger(raw.pid) ||
    (raw.pid ?? 0) <= 0 ||
    typeof raw.userSid !== 'string' ||
    typeof raw.logonSid !== 'string' ||
    typeof raw.logonSessionId !== 'string' ||
    !Number.isSafeInteger(raw.integrityRid) ||
    !Number.isSafeInteger(raw.windowsSessionId) ||
    typeof raw.processStartedAt !== 'string' ||
    typeof raw.executablePath !== 'string' ||
    raw.remote !== false
  ) {
    throw new Error('Native relay returned incomplete peer identity')
  }
  return raw as WindowsControlPeer
}

export async function verifyWindowsControlRelay(
  options: WindowsControlRelayOptions
): Promise<void> {
  if (!isAbsolute(options.helperPath)) throw new Error('Windows relay path must be absolute')
  if (!/^\\\\\.\\pipe\\crosshands-[a-f0-9]{24}$/.test(options.pipeName)) {
    throw new Error('Windows relay pipe name is not a CrossHands session endpoint')
  }
  if (!/^[a-f0-9]{64}$/.test(options.helperSha256)) {
    throw new Error('Windows relay SHA-256 is malformed')
  }
  const info = await lstat(options.helperPath)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Windows relay payload is not a regular package file')
  }
  const bytes = await readFile(options.helperPath)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== options.helperSha256) throw new Error('Windows relay payload hash mismatch')
}

type ConnectionState = {
  dataListeners: Array<(payload: Buffer) => void>
  closeListeners: Array<() => void>
}

/**
 * Launches the native process that owns the named pipe. Node never creates or
 * accepts a Windows pipe directly: unverified bytes cannot reach the broker.
 */
export class NativeWindowsControlRelay implements WindowsControlRelay {
  readonly #options: WindowsControlRelayOptions
  readonly #connections = new Map<bigint, ConnectionState>()
  #child: ChildProcessWithoutNullStreams | undefined
  #ready: Promise<void> | undefined

  constructor(options: WindowsControlRelayOptions) {
    this.#options = options
  }

  async start(): Promise<void> {
    if (this.#child !== undefined) return this.#ready
    if (process.platform !== 'win32') throw new Error('Windows relay can only run on Windows')
    await verifyWindowsControlRelay(this.#options)
    const child = (this.#options.spawnProcess ?? spawn)(
      this.#options.helperPath,
      ['--pipe', this.#options.pipeName, '--broker-pid', String(process.pid)],
      {
        cwd: undefined,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows',
          WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows'
        }
      }
    )
    this.#child = child
    const decoder = new WindowsControlRelayDecoder()
    this.#ready = new Promise<void>((resolve, reject) => {
      let settled = false
      let stderrBytes = 0
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true
          reject(error)
        }
        this.#failAll()
      }
      child.once('error', (cause) => fail(cause))
      child.once('exit', (code) =>
        fail(new Error(`Windows relay exited with code ${String(code)}`))
      )
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength
        if (stderrBytes > 64 * 1024) child.kill()
      })
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          for (const record of decoder.push(chunk)) {
            if (record.type === WINDOWS_CONTROL_RELAY_RECORD.ready) {
              if (!settled) {
                settled = true
                resolve()
              }
              continue
            }
            this.#receive(record)
          }
        } catch (cause) {
          child.kill()
          fail(cause instanceof Error ? cause : new Error('Windows relay protocol failed'))
        }
      })
    })
    return this.#ready
  }

  #receive(record: WindowsControlRelayRecord): void {
    if (record.type === WINDOWS_CONTROL_RELAY_RECORD.open) {
      if (this.#connections.has(record.connectionId)) throw new Error('Duplicate relay connection')
      const state: ConnectionState = { dataListeners: [], closeListeners: [] }
      this.#connections.set(record.connectionId, state)
      const connection: WindowsControlConnection = {
        id: record.connectionId,
        peer: parsePeer(record.payload),
        write: (payload) =>
          this.#write(WINDOWS_CONTROL_RELAY_RECORD.data, record.connectionId, payload),
        close: () => this.#write(WINDOWS_CONTROL_RELAY_RECORD.close, record.connectionId),
        onData: (listener) => state.dataListeners.push(listener),
        onClose: (listener) => state.closeListeners.push(listener)
      }
      this.#options.onConnection(connection)
      return
    }
    const state = this.#connections.get(record.connectionId)
    if (state === undefined) throw new Error('Relay referenced an unknown connection')
    if (record.type === WINDOWS_CONTROL_RELAY_RECORD.data) {
      for (const listener of state.dataListeners) listener(record.payload)
      return
    }
    if (
      record.type === WINDOWS_CONTROL_RELAY_RECORD.close ||
      record.type === WINDOWS_CONTROL_RELAY_RECORD.error
    ) {
      this.#connections.delete(record.connectionId)
      for (const listener of state.closeListeners) listener()
      return
    }
    throw new Error('Unknown relay record type')
  }

  #write(type: number, connectionId: bigint, payload?: Buffer): void {
    const stdin = this.#child?.stdin
    if (stdin === undefined || !stdin.writable) throw new Error('Windows relay is not writable')
    if (!stdin.write(encodeWindowsControlRelayRecord(type, connectionId, payload))) {
      this.#child?.kill()
      throw new Error('Windows relay backpressure limit reached')
    }
  }

  #failAll(): void {
    for (const state of this.#connections.values()) {
      for (const listener of state.closeListeners) listener()
    }
    this.#connections.clear()
  }

  async close(): Promise<void> {
    const child = this.#child
    this.#child = undefined
    this.#ready = undefined
    if (child === undefined) return
    if (child.stdin.writable) {
      child.stdin.end(encodeWindowsControlRelayRecord(WINDOWS_CONTROL_RELAY_RECORD.shutdown, 0n))
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 2_000)
      timer.unref()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.#failAll()
  }
}

type ControlMessage = Record<string, unknown> & { type: string; requestId?: string }

class ControlFrameDecoder {
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
      if (length > this.#maxBytes) throw new Error('Control frame exceeds limit')
      if (this.#buffer.byteLength < 4 + length) break
      const payload = this.#buffer.subarray(4, 4 + length)
      this.#buffer = this.#buffer.subarray(4 + length)
      frames.push(JSON.parse(payload.toString('utf8')) as unknown)
    }
    return frames
  }
}

function controlError(
  requestId: string | undefined,
  code: string,
  message: string
): Record<string, unknown> {
  return { type: 'error', requestId: requestId ?? '', code, message }
}

function sameControlIdentity(left: unknown, right: WindowsControlIdentity): boolean {
  if (left === null || typeof left !== 'object') return false
  const identity = left as Record<string, unknown>
  return (
    identity.osIdentity === right.osIdentity &&
    identity.graphicalSessionId === right.graphicalSessionId
  )
}

/**
 * Control-protocol server for Windows. The relay calls onConnection only after
 * native DACL, locality, SID, logon-session, Windows-session, PID and integrity
 * verification. This layer still requires a versioned handshake before it
 * parses a request envelope or invokes the broker handler.
 */
export class WindowsRelayControlServer {
  readonly #options: WindowsRelayControlServerOptions
  readonly #relay: WindowsControlRelay
  readonly #maxFrameBytes: number
  readonly #maxFrames: number
  readonly #now: () => number
  #requestCount = 0
  #closed = false

  constructor(options: WindowsRelayControlServerOptions) {
    this.#options = options
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_CONTROL_MESSAGE_BYTES
    this.#maxFrames = options.maxFramesPerConnection ?? 1024
    this.#now = options.now ?? Date.now
    this.#relay = (
      options.createRelay ?? ((relayOptions) => new NativeWindowsControlRelay(relayOptions))
    )({
      ...options.relay,
      onConnection: (connection) => this.#accept(connection)
    })
  }

  get requestCount(): number {
    return this.#requestCount
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('Windows control server is closed')
    await this.#relay.start()
  }

  #accept(connection: WindowsControlConnection): void {
    const decoder = new ControlFrameDecoder(this.#maxFrameBytes)
    let authenticated = false
    let frameCount = 0
    let chain = Promise.resolve()
    let closed = false

    const close = (): void => {
      if (closed) return
      closed = true
      try {
        connection.close()
      } catch {
        // The relay already failed closed; there is no usable peer left to notify.
      }
    }
    const send = (message: unknown): void => {
      if (!closed) connection.write(encodeFrame(message, this.#maxFrameBytes))
    }
    const sendAndClose = (message: unknown): void => {
      send(message)
      close()
    }

    connection.onClose(() => {
      closed = true
    })
    connection.onData((chunk) => {
      chain = chain
        .then(async () => {
          for (const raw of decoder.push(chunk)) {
            frameCount += 1
            if (frameCount > this.#maxFrames) throw new Error('Control frame limit exceeded')
            if (raw === null || typeof raw !== 'object' || !('type' in raw)) {
              throw new Error('Malformed control message')
            }
            const message = raw as ControlMessage
            if (!authenticated) {
              if (message.type !== 'handshake') {
                sendAndClose(
                  controlError(message.requestId, 'handshake_required', 'Handshake is required')
                )
                return
              }
              const note = (accepted: boolean, code?: string): void => {
                this.#options.onHandshake?.({
                  accepted,
                  requestId: typeof message.requestId === 'string' ? message.requestId : '',
                  ...(code === undefined ? {} : { code })
                })
              }
              authenticated = this.#authenticate(message)
              if (!authenticated) {
                sendAndClose(
                  controlError(message.requestId, 'peer_rejected', 'Peer authentication failed')
                )
                note(false, 'peer_rejected')
                return
              }
              const offeredVersions = (message as Record<string, unknown>).versions
              if (offeredVersions === null || typeof offeredVersions !== 'object') {
                authenticated = false
                sendAndClose(
                  controlError(message.requestId, 'version_incompatible', 'Versions are required')
                )
                note(false, 'version_incompatible')
                return
              }
              const negotiation = negotiateVersionHandshake(offeredVersions as ContractVersions)
              if (!negotiation.ok) {
                authenticated = false
                sendAndClose(
                  controlError(message.requestId, negotiation.error.code, negotiation.error.message)
                )
                note(false, negotiation.error.code)
                return
              }
              send({ type: 'handshake-ok', requestId: message.requestId })
              note(true)
              continue
            }
            if (message.type !== 'request') {
              sendAndClose(
                controlError(message.requestId, 'invalid_message', 'Expected a request message')
              )
              return
            }
            // oxlint-disable-next-line no-await-in-loop -- one connection preserves frame order.
            await this.#handleRequest(connection.peer, message, send)
          }
        })
        .catch(() => close())
    })
  }

  #authenticate(message: ControlMessage): boolean {
    const record = message as Record<string, unknown>
    return (
      typeof message.requestId === 'string' &&
      record.token === '' &&
      sameControlIdentity(record.identity, this.#options.identity)
    )
  }

  async #handleRequest(
    peer: WindowsControlPeer,
    message: ControlMessage,
    send: (message: unknown) => void
  ): Promise<void> {
    if (
      typeof message.requestId !== 'string' ||
      typeof message.deadlineAt !== 'number' ||
      !Number.isFinite(message.deadlineAt)
    ) {
      send(
        controlError(message.requestId, 'invalid_request', 'Request ID and deadline are required')
      )
      return
    }
    if (message.deadlineAt <= this.#now()) {
      send(controlError(message.requestId, 'timeout', 'Request deadline elapsed'))
      return
    }
    const deadlineAt = message.deadlineAt
    this.#requestCount += 1
    let timer: NodeJS.Timeout | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error('Control request deadline elapsed'), { code: 'timeout' })
            ),
          deadlineAt - this.#now()
        )
        timer.unref()
      })
      const result = await Promise.race([
        this.#options.handler({
          requestId: message.requestId,
          payload: message.payload,
          deadlineAt,
          peer
        }),
        timeout
      ])
      send({ type: 'response', requestId: message.requestId, result })
    } catch (cause) {
      const code =
        typeof cause === 'object' && cause !== null && 'code' in cause
          ? String(cause.code)
          : 'request_failed'
      send(
        controlError(
          message.requestId,
          code,
          cause instanceof Error ? cause.message : 'Request failed'
        )
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#relay.close()
  }
}

export function createWindowsControlServer(
  options: WindowsRelayControlServerOptions
): WindowsRelayControlServer {
  return new WindowsRelayControlServer(options)
}
