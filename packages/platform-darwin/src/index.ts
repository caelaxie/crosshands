import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  COMPUTER_OPERATIONS,
  ProviderHandshakeSchema,
  createComputerError,
  type ComputerOperationName,
  type ComputerProvider,
  type ProviderHandshake,
  type ProviderRequest,
  type ProviderResponse,
  type ReferenceBindings,
  type TargetReference
} from '@crosshands/contract'

type JsonObject = Record<string, unknown>

export const packageVersion = '0.1.0'

type NativeClient = {
  request(method: string, params?: JsonObject): Promise<unknown>
  close(): Promise<void>
}

type NativeClientFactory = (graphicalSessionId: string) => Promise<NativeClient>

type NativeApp = {
  name: string
  bundleId: string | null
  pid: number
  processStartedAt: string
  executableId: string
  isRunning: boolean
}

type NativeWindow = {
  id: number
  index: number
  title: string
  x: number
  y: number
  width: number
  height: number
  isMinimized: boolean
  app?: { bundleId?: string | null; pid?: number }
}

class NativeProviderError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

const HELPER_PATH = fileURLToPath(
  new URL(
    '../assets/CrossHands%20Computer%20Use.app/Contents/MacOS/crosshands-computer-use-macos',
    import.meta.url
  )
)
const MANIFEST_PATH = fileURLToPath(new URL('../assets/payload.json', import.meta.url))
const execFileAsync = promisify(execFile)

export function resolveHelperPath(): string {
  if (!isAbsolute(HELPER_PATH)) throw new Error('CrossHands helper path must be absolute')
  return HELPER_PATH
}

export async function verifyDarwinPayload(
  helperPath = HELPER_PATH,
  manifestPath = MANIFEST_PATH,
  verifySignature = process.platform === 'darwin'
): Promise<void> {
  if (!isAbsolute(helperPath) || !isAbsolute(manifestPath)) {
    throw createComputerError('provider_unavailable', 'macOS payload paths must be absolute')
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    productVersion?: unknown
    bundleIdentifier?: unknown
    files?: Record<string, unknown>
    signing?: {
      required?: unknown
      authority?: unknown
      teamIdentifier?: unknown
      notarized?: unknown
    }
  }
  if (manifest.productVersion !== packageVersion) {
    throw createComputerError('version_incompatible', 'macOS payload product version mismatch')
  }
  if (manifest.bundleIdentifier !== 'ai.crosshands.ComputerUse') {
    throw createComputerError('provider_unavailable', 'macOS helper bundle identity mismatch')
  }
  const expected = manifest.files?.['crosshands-computer-use-macos']
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
    throw createComputerError('provider_unavailable', 'macOS payload manifest is malformed')
  }
  const actual = createHash('sha256')
    .update(await readFile(helperPath))
    .digest('hex')
  if (actual !== expected) {
    throw createComputerError('provider_unavailable', 'macOS provider payload hash mismatch')
  }
  if (!verifySignature) return
  const signing = manifest.signing
  if (
    signing?.required !== true ||
    typeof signing.authority !== 'string' ||
    signing.authority.length === 0 ||
    typeof signing.teamIdentifier !== 'string' ||
    !/^[A-Z0-9]{10}$/.test(signing.teamIdentifier) ||
    signing.notarized !== true
  ) {
    throw createComputerError(
      'provider_unavailable',
      'macOS release payload has no valid signing and notarization policy'
    )
  }
  const appPath = dirname(dirname(dirname(helperPath)))
  try {
    await execFileAsync('/usr/bin/codesign', ['--verify', '--strict', appPath])
    const requirement = await execFileAsync('/usr/bin/codesign', ['-d', '-r-', appPath])
    if (!requirement.stderr.includes('identifier "ai.crosshands.ComputerUse"')) {
      throw new Error('designated requirement does not bind the stable bundle identifier')
    }
    const details = await execFileAsync('/usr/bin/codesign', ['-d', '--verbose=4', appPath])
    if (
      !details.stderr.includes(`Authority=${signing.authority}`) ||
      !details.stderr.includes(`TeamIdentifier=${signing.teamIdentifier}`)
    ) {
      throw new Error('code-signing authority or team identifier does not match the manifest')
    }
    await execFileAsync('/usr/sbin/spctl', ['--assess', '--type', 'execute', appPath])
  } catch (cause) {
    throw createComputerError(
      'provider_unavailable',
      'macOS provider signature verification failed',
      {
        cause: cause instanceof Error ? cause.message : 'unknown'
      }
    )
  }
}

function currentGraphicalSessionId(): string {
  const uid = process.getuid?.()
  const osIdentity = uid === undefined ? `user:${process.env.USER ?? 'unknown'}` : `uid:${uid}`
  return (
    process.env.CROSSHANDS_GRAPHICAL_SESSION_ID ??
    process.env.SECURITYSESSIONID ??
    `interactive:${osIdentity}`
  )
}

class SocketNativeClient implements NativeClient {
  #sequence = 0

  private constructor(
    private readonly child: ChildProcess,
    private readonly directory: string,
    private readonly socketPath: string,
    private readonly token: string
  ) {}

  static async start(graphicalSessionId: string): Promise<SocketNativeClient> {
    const directory = await mkdtemp(join(tmpdir(), 'crosshands-darwin-'))
    await chmod(directory, 0o700)
    const socketPath = join(directory, 'provider.sock')
    const tokenPath = join(directory, 'provider.token')
    const token = randomBytes(32).toString('base64url')
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600, flag: 'wx' })
    const child = spawn(resolveHelperPath(), ['--agent', socketPath, '--token-file', tokenPath], {
      env: { ...process.env, CROSSHANDS_GRAPHICAL_SESSION_ID: graphicalSessionId },
      stdio: 'ignore'
    })
    const client = new SocketNativeClient(child, directory, socketPath, token)
    const deadline = Date.now() + 3_000
    let lastError: unknown
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break
      try {
        // oxlint-disable-next-line no-await-in-loop -- readiness requires ordered retries.
        await client.request('handshake')
        return client
      } catch (cause) {
        lastError = cause
        // oxlint-disable-next-line no-await-in-loop -- readiness requires ordered retries.
        await new Promise<void>((resolve) => setTimeout(resolve, 40))
      }
    }
    await client.close()
    throw createComputerError('provider_unavailable', 'CrossHands macOS helper did not start', {
      cause: lastError instanceof Error ? lastError.message : `exit ${String(child.exitCode)}`
    })
  }

  request(method: string, params: JsonObject = {}): Promise<unknown> {
    const id = ++this.#sequence
    const payload = JSON.stringify({ id, method, params, token: this.token }) + '\n'
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath)
      let buffer = ''
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new NativeProviderError('timeout', `macOS helper timed out during ${method}`))
      }, 30_000)
      timer.unref()
      const finish = (): void => clearTimeout(timer)
      socket.setEncoding('utf8')
      socket.once('connect', () => socket.end(payload))
      socket.on('data', (chunk: string) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        finish()
        socket.destroy()
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as JsonObject
          if (response.id !== id) throw new Error('macOS helper response id mismatch')
          if (response.ok === true) resolve(response.result)
          else {
            const error = asObject(response.error)
            reject(
              new NativeProviderError(
                typeof error.code === 'string' ? error.code : 'accessibility_error',
                typeof error.message === 'string' ? error.message : 'macOS helper failed'
              )
            )
          }
        } catch (cause) {
          reject(cause)
        }
      })
      socket.once('error', (cause) => {
        finish()
        reject(cause)
      })
    })
  }

  async close(): Promise<void> {
    if (this.child.exitCode === null) {
      await this.request('terminate').catch(() => undefined)
      this.child.kill('SIGTERM')
    }
    await rm(this.directory, { recursive: true, force: true })
  }
}

function asObject(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected an object from the macOS helper')
  }
  return value as JsonObject
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`Missing ${field}`)
  return value
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`Missing ${field}`)
  return value
}

function nativeApp(value: unknown): NativeApp {
  const app = asObject(value)
  return {
    name: asString(app.name, 'app.name'),
    bundleId: typeof app.bundleId === 'string' ? app.bundleId : null,
    pid: asNumber(app.pid, 'app.pid'),
    processStartedAt: asString(app.processStartedAt, 'app.processStartedAt'),
    executableId: asString(app.executableId, 'app.executableId'),
    isRunning: app.isRunning !== false
  }
}

function appId(app: NativeApp): string {
  return app.bundleId ?? app.executableId
}

function normalizeApp(app: NativeApp): JsonObject {
  return {
    id: appId(app),
    name: app.name,
    bundleId: app.bundleId,
    pid: app.pid,
    isRunning: app.isRunning
  }
}

function nativeWindow(value: unknown): NativeWindow {
  const window = asObject(value)
  const normalized: NativeWindow = {
    id: asNumber(window.id, 'window.id'),
    index: asNumber(window.index, 'window.index'),
    title: typeof window.title === 'string' ? window.title : '',
    x: asNumber(window.x, 'window.x'),
    y: asNumber(window.y, 'window.y'),
    width: asNumber(window.width, 'window.width'),
    height: asNumber(window.height, 'window.height'),
    isMinimized: window.isMinimized === true
  }
  if (window.app !== undefined) {
    normalized.app = asObject(window.app) as NonNullable<NativeWindow['app']>
  }
  return normalized
}

function normalizeWindow(window: NativeWindow, owner: NativeApp): JsonObject {
  return {
    id: String(window.id),
    appId: appId(owner),
    title: window.title,
    index: window.index,
    bounds: { x: window.x, y: window.y, width: window.width, height: window.height },
    minimized: window.isMinimized
  }
}

function bindings(
  app: NativeApp,
  window: NativeWindow,
  snapshotId: string,
  generation: string,
  graphicalSessionId: string
): ReferenceBindings {
  return {
    brokerGeneration: 'pending-broker',
    providerGeneration: generation,
    graphicalSessionId,
    process: { pid: app.pid, startedAt: app.processStartedAt, executableId: app.executableId },
    appId: appId(app),
    window: { id: String(window.id), ownerPid: app.pid },
    snapshotId,
    desktopEpoch: 0
  }
}

function normalizeSnapshot(
  value: unknown,
  generation: string,
  graphicalSessionId: string
): JsonObject {
  const raw = asObject(value)
  const snapshot = asObject(raw.snapshot)
  const app = nativeApp(snapshot.app)
  const window = nativeWindow(snapshot.window)
  const id = asString(snapshot.id, 'snapshot.id')
  return {
    bindings: bindings(app, window, id, generation, graphicalSessionId),
    snapshot: {
      id,
      app: normalizeApp(app),
      window: normalizeWindow(window, app),
      treeText: typeof snapshot.treeText === 'string' ? snapshot.treeText : '',
      elementCount: asNumber(snapshot.elementCount, 'snapshot.elementCount'),
      focusedElementRef:
        typeof snapshot.focusedElementId === 'number'
          ? `element:${snapshot.focusedElementId}`
          : null,
      desktopEpoch: 0
    },
    screenshot:
      raw.screenshot === null || raw.screenshot === undefined
        ? null
        : normalizeScreenshot(raw.screenshot)
  }
}

function normalizeScreenshot(value: unknown): JsonObject {
  const screenshot = asObject(value)
  return {
    format: 'png',
    width: asNumber(screenshot.width, 'screenshot.width'),
    height: asNumber(screenshot.height, 'screenshot.height'),
    scale: asNumber(screenshot.scale, 'screenshot.scale'),
    data: asString(screenshot.data, 'screenshot.data')
  }
}

function targetReference(input: JsonObject): TargetReference | undefined {
  for (const key of ['target', 'from', 'to']) {
    const target = input[key]
    if (target === null || typeof target !== 'object') continue
    const record = target as JsonObject
    const candidate = record.kind === 'element' ? record.ref : (record.window ?? target)
    if (candidate !== null && typeof candidate === 'object' && 'snapshotId' in candidate) {
      return candidate as TargetReference
    }
  }
  return undefined
}

function nativeTarget(target: unknown, prefix = ''): JsonObject {
  const value = asObject(target)
  const elementKey = prefix.length === 0 ? 'elementIndex' : `${prefix}ElementIndex`
  const xKey = prefix.length === 0 ? 'x' : `${prefix}X`
  const yKey = prefix.length === 0 ? 'y' : `${prefix}Y`
  if (value.kind === 'element') {
    const ref = asObject(value.ref)
    const index = Number(asString(ref.ref, 'element ref').replace(/^element:/, ''))
    if (!Number.isInteger(index) || index < 0) throw new TypeError('Invalid element reference')
    return { [elementKey]: index, snapshotId: ref.snapshotId }
  }
  if (value.kind === 'coordinate') {
    return {
      [xKey]: asNumber(value.x, `${prefix}x`),
      [yKey]: asNumber(value.y, `${prefix}y`),
      ...(value.window === undefined ? {} : { snapshotId: asObject(value.window).snapshotId })
    }
  }
  if ('snapshotId' in value) return { snapshotId: value.snapshotId }
  throw new TypeError('Unsupported macOS action target')
}

function nativeInput(operation: ComputerOperationName, input: unknown): JsonObject {
  const value = asObject(input)
  const common = {
    ...(typeof value.app === 'string' ? { app: value.app } : {}),
    ...(value.restoreWindow === true ? { restoreWindow: true } : {}),
    ...(value.captureScreenshot === false ? { noScreenshot: true } : {})
  }
  if (operation === 'getAppState') {
    const window = value.window === undefined ? undefined : asObject(value.window)
    return {
      ...common,
      app: value.app,
      ...(window?.id === undefined ? {} : { windowId: Number(window.id) }),
      ...(window?.index === undefined ? {} : { windowIndex: window.index })
    }
  }
  if (operation === 'listWindows') return { app: value.app }
  if (!COMPUTER_OPERATIONS[operation].mutation) return value
  const reference = targetReference(value)
  const app =
    typeof value.app === 'string'
      ? value.app
      : reference
        ? `pid:${reference.process.pid}`
        : undefined
  const actionCommon = { ...common, ...(app === undefined ? {} : { app }) }
  if (operation === 'drag') {
    return { ...actionCommon, ...nativeTarget(value.from, 'from'), ...nativeTarget(value.to, 'to') }
  }
  const target = nativeTarget(value.target)
  switch (operation) {
    case 'click':
      return { ...actionCommon, ...target, mouseButton: value.button, clickCount: value.clickCount }
    case 'performSecondaryAction':
      return { ...actionCommon, ...target, action: value.action }
    case 'scroll':
      return { ...actionCommon, ...target, direction: value.direction, pages: value.pages }
    case 'hotkey':
      return { ...actionCommon, ...target, key: (value.keys as string[]).join('+') }
    case 'typeText':
    case 'pasteText':
      return { ...actionCommon, ...target, text: value.text }
    case 'pressKey':
      return { ...actionCommon, ...target, key: value.key }
    case 'setValue':
      return { ...actionCommon, ...target, value: value.value }
    default:
      return { ...actionCommon, ...target }
  }
}

function errorCode(code: string): Parameters<typeof createComputerError>[0] {
  const aliases: Record<string, Parameters<typeof createComputerError>[0]> = {
    window_stale: 'stale_target',
    action_timeout: 'timeout'
  }
  if (code in aliases) return aliases[code]!
  const known = [
    'app_not_found',
    'app_blocked',
    'window_not_found',
    'window_not_focused',
    'permission_denied',
    'element_not_found',
    'element_not_clickable',
    'action_not_supported',
    'value_not_settable',
    'invalid_argument',
    'timeout',
    'screenshot_failed',
    'accessibility_error'
  ]
  return known.includes(code)
    ? (code as Parameters<typeof createComputerError>[0])
    : 'accessibility_error'
}

function mutationResult(
  value: unknown,
  generation: string,
  graphicalSessionId: string
): JsonObject {
  const raw = asObject(value)
  const action = asObject(raw.action)
  const verification = action.verification === undefined ? undefined : asObject(action.verification)
  return {
    outcome:
      verification?.state === 'verified'
        ? { state: 'verified', evidence: action }
        : {
            state: 'indeterminate',
            reason: String(verification?.reason ?? 'verification unavailable')
          },
    freshState: normalizeSnapshot(raw, generation, graphicalSessionId)
  }
}

export class DarwinComputerProvider implements ComputerProvider {
  #generation = 'darwin-starting'
  #client: NativeClient | undefined
  #handshake: ProviderHandshake | undefined

  constructor(
    private readonly graphicalSessionId = currentGraphicalSessionId(),
    private readonly clientFactory: NativeClientFactory = SocketNativeClient.start,
    private readonly verifyPayload = clientFactory === SocketNativeClient.start
  ) {}

  get generation(): string {
    return this.#generation
  }

  async start(): Promise<ProviderHandshake> {
    if (this.#handshake !== undefined) return this.#handshake
    if (this.verifyPayload) await verifyDarwinPayload()
    this.#client = await this.clientFactory(this.graphicalSessionId)
    const handshake = ProviderHandshakeSchema.parse(await this.#client.request('handshake'))
    this.#generation = handshake.generation
    this.#handshake = handshake
    return handshake
  }

  async dispatch(request: ProviderRequest): Promise<ProviderResponse> {
    const client = this.#client ?? (await this.start(), this.#client)
    if (client === undefined) throw new Error('macOS provider failed to start')
    try {
      const raw = await client.request(
        request.operation,
        nativeInput(request.operation, request.input)
      )
      let result: unknown = raw
      if (request.operation === 'listApps') {
        result = {
          apps: (asObject(raw).apps as unknown[]).map((app) => normalizeApp(nativeApp(app)))
        }
      } else if (request.operation === 'listWindows') {
        const response = asObject(raw)
        const owner = nativeApp(response.app)
        result = {
          windows: (response.windows as unknown[]).map((window) =>
            normalizeWindow(nativeWindow(window), owner)
          )
        }
      } else if (request.operation === 'getAppState') {
        result = normalizeSnapshot(raw, this.generation, this.graphicalSessionId)
      } else if (COMPUTER_OPERATIONS[request.operation].mutation) {
        result = mutationResult(raw, this.generation, this.graphicalSessionId)
      }
      return {
        requestId: request.requestId,
        dispatched: COMPUTER_OPERATIONS[request.operation].mutation,
        result
      }
    } catch (cause) {
      const native =
        cause instanceof NativeProviderError
          ? cause
          : new NativeProviderError(
              'accessibility_error',
              cause instanceof Error ? cause.message : 'macOS provider failed'
            )
      const error = createComputerError(errorCode(native.code), native.message)
      const notDispatched = new Set([
        'permission_denied',
        'invalid_argument',
        'app_not_found',
        'app_blocked',
        'window_not_found',
        'window_stale',
        'element_not_found',
        'action_not_supported',
        'value_not_settable'
      ])
      return {
        requestId: request.requestId,
        dispatched: !notDispatched.has(native.code),
        error: error.toJSON()
      }
    }
  }

  async cancel(_requestId: string): Promise<void> {
    await this.close()
  }

  async close(): Promise<void> {
    const client = this.#client
    this.#client = undefined
    this.#handshake = undefined
    await client?.close()
  }

  async inspect(
    operation: ComputerOperationName,
    input: unknown
  ): Promise<{
    bindings: ReferenceBindings
    appIdentity: { appId: string; executableId: string }
  } | null> {
    if (operation === 'capabilities' || operation === 'permissions' || operation === 'listApps')
      return null
    const client = this.#client ?? (await this.start(), this.#client)
    if (client === undefined) return null
    const value = asObject(input)
    const reference = targetReference(value)
    const query =
      typeof value.app === 'string'
        ? value.app
        : reference
          ? `pid:${reference.process.pid}`
          : undefined
    if (query === undefined) return null
    const apps = (asObject(await client.request('listApps')).apps as unknown[]).map(nativeApp)
    const app = apps.find(
      (candidate) =>
        candidate.name.toLowerCase() === query.toLowerCase() ||
        candidate.bundleId?.toLowerCase() === query.toLowerCase() ||
        `pid:${candidate.pid}` === query
    )
    if (app === undefined) return null
    const windows = asObject(await client.request('listWindows', { app: `pid:${app.pid}` }))
      .windows as unknown[]
    const requestedWindow =
      reference?.window.id ??
      (value.window === undefined ? undefined : String(asObject(value.window).id ?? ''))
    const window = windows
      .map(nativeWindow)
      .find(
        (candidate) => requestedWindow === undefined || String(candidate.id) === requestedWindow
      )
    if (window === undefined) return null
    const current = bindings(
      app,
      window,
      reference?.snapshotId ?? 'inspection',
      this.generation,
      this.graphicalSessionId
    )
    return {
      bindings:
        reference === undefined
          ? current
          : {
              ...current,
              brokerGeneration: reference.brokerGeneration,
              snapshotId: reference.snapshotId,
              desktopEpoch: reference.desktopEpoch
            },
      appIdentity: { appId: appId(app), executableId: app.executableId }
    }
  }
}

let activeProvider: DarwinComputerProvider | undefined

export function createProvider(): ComputerProvider {
  activeProvider = new DarwinComputerProvider()
  return activeProvider
}

export async function inspectTarget(operation: ComputerOperationName, input: unknown) {
  return activeProvider?.inspect(operation, input) ?? null
}
