import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, readFile, readlink, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import {
  COMPUTER_OPERATIONS,
  CONTRACT_VERSIONS,
  createComputerError,
  type ComputerError,
  type ComputerOperationName,
  type ComputerProvider,
  type ProviderHandshake,
  type ProviderRequest,
  type ProviderResponse,
  type ReferenceBindings,
  type TargetReference
} from '@crosshands/contract'

const FIXED_SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin'
export const packageVersion = CONTRACT_VERSIONS.product
const MAX_NATIVE_FRAME_BYTES = 1_048_576
const PACKAGED_RUNTIME = fileURLToPath(new URL('../assets/runtime.py', import.meta.url))
const PACKAGED_MANIFEST = fileURLToPath(new URL('../assets/payload.json', import.meta.url))

type NativeReadiness = {
  available: boolean
  sessionType: string
  graphicalSessionId: string
  issues: Array<{ code: string; component: string; message: string }>
  capabilities: Record<string, boolean>
}

type NativeHandshake = {
  type: 'handshake'
  provider: string
  providerVersion: string
  providerProtocol: number
  publicContract: string
  generation: string
  graphicalSessionId: string
  capabilities: {
    readiness: NativeReadiness
    supports: { actions: Record<string, boolean>; observation: Record<string, boolean> }
  }
}

type NativeResponse =
  | { type: 'response'; requestId: string; ok: true; result: Record<string, unknown> }
  | { type: 'response'; requestId: string; ok: false; error: string }
type NativeFrame = NativeHandshake | NativeResponse | { type: 'fatal'; error: string }
type Pending = { resolve: (frame: NativeResponse) => void; reject: (cause: unknown) => void }

type Environment = Readonly<Record<string, string | undefined>>

export function linuxProviderEnvironment(source: Environment = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: FIXED_SYSTEM_PATH,
    LANG: source.LANG ?? 'C.UTF-8',
    LC_ALL: source.LC_ALL ?? 'C.UTF-8',
    PYTHONNOUSERSITE: '1'
  }
  for (const name of [
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_SESSION_TYPE',
    'XDG_SESSION_ID',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS'
  ] as const) {
    const value = source[name]
    if (value !== undefined && value.length > 0) result[name] = value
  }
  return result
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function captureOptions(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(input.captureScreenshot === false ? { noScreenshot: true } : {}),
    ...(input.restoreWindow === true ? { restoreWindow: true } : {})
  }
}

function targetFields(targetValue: unknown, prefix = ''): Record<string, unknown> {
  const target = record(targetValue)
  if (target.kind === 'coordinate') {
    return { [`${prefix}x`]: target.x, [`${prefix}y`]: target.y }
  }
  const reference = record(target.ref ?? target)
  if (reference.kind === 'element') {
    const match = /^element:(\d+)$/.exec(String(reference.ref ?? ''))
    return match === null ? {} : { [`${prefix}elementIndex`]: Number(match[1]) }
  }
  if (target.kind === 'element' && typeof target.elementIndex === 'number') {
    return { [`${prefix}elementIndex`]: target.elementIndex }
  }
  return {}
}

export function mapNativeOperation(
  operation: ComputerOperationName,
  inputValue: unknown
): Record<string, unknown> {
  const input = record(inputValue)
  const base = typeof input.app === 'string' ? { app: input.app } : {}
  switch (operation) {
    case 'capabilities':
      return { tool: 'handshake' }
    case 'permissions':
      return { tool: 'handshake' }
    case 'listApps':
      return { tool: 'list_apps' }
    case 'listWindows':
      return { tool: 'list_windows', app: input.app }
    case 'getAppState': {
      const window = record(input.window)
      return {
        tool: 'get_app_state',
        app: input.app,
        ...(typeof window.id === 'string' ? { windowId: window.id } : {}),
        ...(typeof window.index === 'number' ? { windowIndex: window.index } : {}),
        ...captureOptions(input)
      }
    }
    case 'click':
      return {
        tool: 'click',
        ...base,
        ...targetFields(input.target),
        ...(typeof input.clickCount === 'number' ? { click_count: input.clickCount } : {}),
        ...(typeof input.button === 'string' ? { mouse_button: input.button } : {}),
        ...captureOptions(input)
      }
    case 'performSecondaryAction':
      return {
        tool: 'perform_secondary_action',
        ...base,
        ...targetFields(input.target),
        action: input.action,
        ...captureOptions(input)
      }
    case 'scroll':
      return {
        tool: 'scroll',
        ...base,
        ...targetFields(input.target),
        direction: input.direction,
        ...(typeof input.pages === 'number' ? { pages: input.pages } : {}),
        ...captureOptions(input)
      }
    case 'drag':
      return {
        tool: 'drag',
        ...base,
        ...targetFields(input.from, 'from_'),
        ...targetFields(input.to, 'to_'),
        ...captureOptions(input)
      }
    case 'typeText':
      return { tool: 'type_text', ...base, text: input.text, ...captureOptions(input) }
    case 'pressKey':
      return { tool: 'press_key', ...base, key: input.key, ...captureOptions(input) }
    case 'hotkey':
      return {
        tool: 'hotkey',
        ...base,
        key: Array.isArray(input.keys) ? input.keys.join('+') : input.keys,
        ...captureOptions(input)
      }
    case 'pasteText':
      return { tool: 'paste_text', ...base, text: input.text, ...captureOptions(input) }
    case 'setValue':
      return {
        tool: 'set_value',
        ...base,
        ...targetFields(input.target),
        value: input.value,
        ...captureOptions(input)
      }
    default:
      throw createComputerError('invalid_argument', `Unknown Linux operation: ${operation}`)
  }
}

export function normalizeNativeError(message: string): ComputerError {
  const normalized = message.toLowerCase()
  if (normalized.includes('appblocked'))
    return createComputerError('app_blocked', 'Sensitive applications are blocked by default')
  if (normalized.includes('appnotfound')) return createComputerError('app_not_found', message)
  if (normalized.includes('windownotfound') || normalized.includes('no top-level'))
    return createComputerError('window_not_found', message)
  if (normalized.includes('window_not_focused'))
    return createComputerError('window_not_focused', message)
  if (normalized.includes('stale')) return createComputerError('stale_target', message)
  if (normalized.includes('unsupported_capability'))
    return createComputerError('unsupported_capability', message)
  if (normalized.includes('provider_unavailable'))
    return createComputerError('provider_unavailable', message)
  if (normalized.includes('not settable')) return createComputerError('value_not_settable', message)
  if (normalized.includes('not a valid secondary action'))
    return createComputerError('action_not_supported', message)
  return createComputerError('accessibility_error', message)
}

export async function verifyLinuxPayload(
  runtimePath = PACKAGED_RUNTIME,
  manifestPath = PACKAGED_MANIFEST
): Promise<void> {
  if (!isAbsolute(runtimePath) || !isAbsolute(manifestPath))
    throw createComputerError('provider_unavailable', 'Linux payload paths must be absolute')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    productVersion?: unknown
    files?: Record<string, unknown>
  }
  if (manifest.productVersion !== packageVersion)
    throw createComputerError('version_incompatible', 'Linux payload product version mismatch')
  const expected = manifest.files?.['runtime.py']
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))
    throw createComputerError('provider_unavailable', 'Linux payload manifest is malformed')
  const actual = createHash('sha256')
    .update(await readFile(runtimePath))
    .digest('hex')
  if (actual !== expected)
    throw createComputerError('provider_unavailable', 'Linux provider payload hash mismatch')
}

async function selectPython(explicit?: string): Promise<string> {
  const candidates =
    explicit === undefined ? ['/usr/bin/python3', '/usr/local/bin/python3'] : [explicit]
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue
    try {
      // oxlint-disable-next-line no-await-in-loop -- fixed candidates are checked in order.
      await access(candidate)
      return candidate
    } catch {
      // Continue to the next fixed absolute candidate.
    }
  }
  throw createComputerError(
    'provider_unavailable',
    'Python 3 was not found at a supported absolute path; install python3'
  )
}

function operations(readiness: NativeReadiness): Record<string, boolean> {
  const capability = readiness.capabilities
  const observation = readiness.available && capability.accessibility === true
  return {
    capabilities: true,
    permissions: true,
    listApps: observation,
    listWindows: observation,
    getAppState: observation,
    click:
      observation && (capability.semanticActions === true || capability.syntheticPointer === true),
    performSecondaryAction: observation && capability.semanticActions === true,
    scroll: observation && capability.syntheticPointer === true,
    drag: observation && capability.syntheticPointer === true,
    typeText: observation && capability.syntheticKeyboard === true,
    pressKey: observation && capability.syntheticKeyboard === true,
    hotkey: observation && capability.hotkey === true,
    pasteText:
      observation && capability.clipboard === true && capability.syntheticKeyboard === true,
    setValue: observation && capability.semanticActions === true
  }
}

function targetReference(input: unknown): TargetReference | undefined {
  const source = record(input)
  for (const candidate of [source.target, source.from, source.to]) {
    const target = record(candidate)
    const reference = record(target.ref ?? target.window ?? target)
    if (typeof reference.contextToken === 'string' && typeof reference.ref === 'string')
      return reference as TargetReference
  }
  return undefined
}

async function processIdentity(pid: number): Promise<ReferenceBindings['process']> {
  const [executable, executableInfo, processInfo, processStat, bootId] = await Promise.all([
    readlink(`/proc/${pid}/exe`),
    stat(`/proc/${pid}/exe`),
    stat(`/proc/${pid}`),
    readFile(`/proc/${pid}/stat`, 'utf8'),
    readFile('/proc/sys/kernel/random/boot_id', 'utf8')
  ])
  const afterCommand = processStat
    .slice(processStat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/)
  // /proc/<pid>/stat field 22 is starttime; the sliced sequence starts at field 3.
  const startTicks = afterCommand[19]
  if (startTicks === undefined || !/^\d+$/.test(startTicks))
    throw createComputerError('provider_unavailable', 'Linux process start identity is unavailable')
  return {
    pid,
    startedAt: processInfo.ctime.toISOString(),
    executableId: `${executable}:${executableInfo.dev}:${executableInfo.ino}:${bootId.trim()}:${startTicks}`
  }
}

function appInfo(rawValue: unknown): {
  id: string
  name: string
  bundleId: string
  pid: number
  isRunning: true
} {
  const raw = record(rawValue)
  const pid = Number(raw.pid)
  const name = String(raw.name ?? 'Unknown')
  return { id: `linux:${pid}:${name}`, name, bundleId: name, pid, isRunning: true }
}

function nativeWindowId(pid: number, index: number): string {
  return `linux:${pid}:window:${index}`
}

export type LinuxComputerProviderOptions = {
  runtimePath?: string
  manifestPath?: string
  pythonPath?: string
  environment?: Environment
  skipPayloadVerification?: boolean
}

export class LinuxComputerProvider implements ComputerProvider {
  readonly runtimePath: string
  readonly #manifestPath: string
  readonly #pythonPath: string | undefined
  readonly #environment: Environment
  readonly #skipPayloadVerification: boolean
  readonly #pending = new Map<string, Pending>()
  readonly #elements = new Map<string, unknown[]>()
  #child: ChildProcessWithoutNullStreams | undefined
  #lines: Interface | undefined
  #handshake: NativeHandshake | undefined
  #handshakeWait: Promise<NativeHandshake> | undefined
  #resolveHandshake: ((value: NativeHandshake) => void) | undefined
  #rejectHandshake: ((cause: unknown) => void) | undefined
  #generation = `linux-unstarted-${randomUUID()}`
  #stderr = ''

  constructor(options: LinuxComputerProviderOptions = {}) {
    this.runtimePath = options.runtimePath ?? PACKAGED_RUNTIME
    this.#manifestPath = options.manifestPath ?? PACKAGED_MANIFEST
    this.#pythonPath = options.pythonPath
    this.#environment = options.environment ?? process.env
    this.#skipPayloadVerification = options.skipPayloadVerification ?? false
  }

  get generation(): string {
    return this.#generation
  }

  async start(): Promise<ProviderHandshake> {
    if (this.#handshake !== undefined) return this.#contractHandshake(this.#handshake)
    if (!this.#skipPayloadVerification)
      await verifyLinuxPayload(this.runtimePath, this.#manifestPath)
    const python = await selectPython(this.#pythonPath)
    this.#handshakeWait = new Promise<NativeHandshake>((resolve, reject) => {
      this.#resolveHandshake = resolve
      this.#rejectHandshake = reject
    })
    const child = spawn(python, ['-I', '-u', this.runtimePath], {
      cwd: '/',
      env: linuxProviderEnvironment(this.#environment),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.#child = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-4096)
    })
    child.once('error', (cause) => this.#failAll(cause))
    child.once('exit', (code, signal) =>
      this.#failAll(
        createComputerError('provider_crashed', 'Linux provider process exited', { code, signal })
      )
    )
    this.#lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.#lines.on('line', (line) => this.#handleLine(line))
    const handshake = await this.#handshakeWait
    this.#handshake = handshake
    this.#generation = handshake.generation
    return this.#contractHandshake(handshake)
  }

  #contractHandshake(handshake: NativeHandshake): ProviderHandshake {
    const readiness = handshake.capabilities.readiness
    return {
      provider: handshake.provider,
      generation: handshake.generation,
      graphicalSessionId: handshake.graphicalSessionId,
      providerProtocol: handshake.providerProtocol,
      publicContract: handshake.publicContract,
      capabilities: {
        platform: 'linux',
        provider: handshake.provider,
        providerVersion: handshake.providerVersion,
        operations: operations(readiness),
        permissions: {
          accessibility: readiness.capabilities.accessibility === true ? 'granted' : 'denied',
          screenshots:
            readiness.sessionType === 'wayland'
              ? 'not_required'
              : readiness.capabilities.screenshots === true
                ? 'granted'
                : 'denied'
        }
      }
    }
  }

  #handleLine(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > MAX_NATIVE_FRAME_BYTES) {
      this.#failAll(
        createComputerError('provider_crashed', 'Linux provider emitted an oversized frame')
      )
      void this.close()
      return
    }
    let frame: NativeFrame
    try {
      frame = JSON.parse(line) as NativeFrame
    } catch {
      this.#failAll(
        createComputerError('provider_crashed', 'Linux provider emitted malformed JSON')
      )
      void this.close()
      return
    }
    if (frame.type === 'handshake') {
      this.#resolveHandshake?.(frame)
      return
    }
    if (frame.type === 'fatal') {
      this.#failAll(createComputerError('provider_crashed', frame.error))
      return
    }
    const pending = this.#pending.get(frame.requestId)
    if (pending === undefined) return
    this.#pending.delete(frame.requestId)
    pending.resolve(frame)
  }

  #failAll(cause: unknown): void {
    this.#rejectHandshake?.(cause)
    this.#rejectHandshake = undefined
    this.#resolveHandshake = undefined
    for (const pending of this.#pending.values()) pending.reject(cause)
    this.#pending.clear()
  }

  async dispatch(request: ProviderRequest): Promise<ProviderResponse> {
    const handshake = this.#handshake ?? (await this.start(), this.#handshake)
    const child = this.#child
    if (handshake === undefined || child === undefined)
      throw createComputerError('provider_unavailable', 'Linux provider failed to start')
    if (request.operation !== 'capabilities' && request.operation !== 'permissions') {
      const supported = operations(handshake.capabilities.readiness)[request.operation]
      if (supported !== true) {
        return {
          requestId: request.requestId,
          dispatched: false,
          error: createComputerError(
            handshake.capabilities.readiness.available
              ? 'unsupported_capability'
              : 'provider_unavailable',
            handshake.capabilities.readiness.issues.map((issue) => issue.message).join('; ') ||
              `${request.operation} is unavailable in this session`
          ).toJSON()
        }
      }
      const input = record(request.input)
      const requestsScreenshot =
        (request.operation === 'getAppState' || COMPUTER_OPERATIONS[request.operation].mutation) &&
        input.captureScreenshot !== false
      if (
        requestsScreenshot &&
        handshake.capabilities.readiness.capabilities.screenshots !== true
      ) {
        return {
          requestId: request.requestId,
          dispatched: false,
          error: createComputerError(
            'unsupported_capability',
            `Window screenshots are unavailable in ${handshake.capabilities.readiness.sessionType} sessions; retry with captureScreenshot=false`
          ).toJSON()
        }
      }
      if (
        request.operation === 'click' &&
        record(input.target).kind === 'coordinate' &&
        handshake.capabilities.readiness.capabilities.syntheticPointer !== true
      ) {
        return {
          requestId: request.requestId,
          dispatched: false,
          error: createComputerError(
            'unsupported_capability',
            `Coordinate clicking is unavailable in ${handshake.capabilities.readiness.sessionType} sessions`
          ).toJSON()
        }
      }
    }

    const nativeOperation = this.#attachElementRecords(
      mapNativeOperation(request.operation, request.input),
      request.input
    )
    const frame = await new Promise<NativeResponse>((resolve, reject) => {
      this.#pending.set(request.requestId, { resolve, reject })
      child.stdin.write(
        `${JSON.stringify({ type: 'request', requestId: request.requestId, operation: nativeOperation })}\n`,
        (cause) => {
          if (cause === null || cause === undefined) return
          this.#pending.delete(request.requestId)
          reject(cause)
        }
      )
    })
    if (!frame.ok) {
      return {
        requestId: request.requestId,
        dispatched: false,
        error: normalizeNativeError(frame.error).toJSON()
      }
    }
    return {
      requestId: request.requestId,
      dispatched: COMPUTER_OPERATIONS[request.operation].mutation,
      result: await this.#normalizeResult(request.operation, frame.result)
    }
  }

  #attachElementRecords(
    operation: Record<string, unknown>,
    input: unknown
  ): Record<string, unknown> {
    const result = { ...operation }
    const source = record(input)
    for (const [targetName, nativeName] of [
      ['target', 'element'],
      ['from', 'fromElement'],
      ['to', 'toElement']
    ] as const) {
      const target = record(source[targetName])
      const reference = record(target.ref ?? target)
      const match = /^element:(\d+)$/.exec(String(reference.ref ?? ''))
      const elements = this.#elements.get(String(reference.snapshotId ?? ''))
      const index = match === null ? undefined : Number(match[1])
      if (elements !== undefined && index !== undefined && elements[index] !== undefined)
        result[nativeName] = elements[index]
    }
    return result
  }

  async #normalizeResult(
    operation: ComputerOperationName,
    native: Record<string, unknown>
  ): Promise<unknown> {
    const handshake = this.#handshake!
    if (operation === 'capabilities') return this.#contractHandshake(handshake).capabilities
    if (operation === 'permissions')
      return { permissions: this.#contractHandshake(handshake).capabilities.permissions }
    if (operation === 'listApps') {
      const apps = Array.isArray(native.apps) ? native.apps.map(appInfo) : []
      return { apps }
    }
    if (operation === 'listWindows') {
      const windows = Array.isArray(native.windows) ? native.windows : []
      return {
        windows: windows.map((value) => {
          const window = record(value)
          const app = appInfo(window.app)
          return {
            id: nativeWindowId(app.pid, Number(window.index)),
            appId: app.id,
            title: String(window.title ?? ''),
            index: Number(window.index),
            bounds: {
              x: Number(window.x),
              y: Number(window.y),
              width: Number(window.width),
              height: Number(window.height)
            },
            minimized: window.isMinimized === true
          }
        })
      }
    }

    const rawSnapshot = record(native.snapshot)
    const normalizedSnapshot = await this.#normalizeSnapshot(rawSnapshot)
    if (operation === 'getAppState') return normalizedSnapshot
    const action = record(native.action)
    const verification = record(action.verification)
    const verified = action.path === 'accessibility' && verification.state !== 'unverified'
    return {
      outcome: verified
        ? {
            state: 'verified',
            evidence: { action: action.actionName, snapshotId: normalizedSnapshot.snapshot.id }
          }
        : {
            state: 'indeterminate',
            reason:
              typeof verification.reason === 'string'
                ? verification.reason
                : 'fresh state returned but the provider could not prove the requested effect'
          }
    }
  }

  async #normalizeSnapshot(raw: Record<string, unknown>): Promise<{
    bindings: ReferenceBindings
    snapshot: Record<string, unknown>
    screenshot: Record<string, unknown> | null
  }> {
    const app = appInfo(raw.app)
    const snapshotId = String(raw.snapshotId)
    const index = Number(raw.windowIndex)
    const bounds = record(raw.windowBounds)
    const process = await processIdentity(app.pid)
    const windowId = nativeWindowId(app.pid, index)
    const elements = Array.isArray(raw.elements) ? raw.elements : []
    this.#elements.set(snapshotId, elements)
    if (this.#elements.size > 32) this.#elements.delete(this.#elements.keys().next().value!)
    const bindings: ReferenceBindings = {
      brokerGeneration: 'broker-pending',
      providerGeneration: this.generation,
      graphicalSessionId: this.#handshake!.graphicalSessionId,
      process,
      appId: app.id,
      window: { id: windowId, ownerPid: app.pid },
      snapshotId,
      desktopEpoch: 0
    }
    const width = Number(raw.screenshotWidth)
    const height = Number(raw.screenshotHeight)
    const screenshotData = raw.screenshotPngBase64
    return {
      bindings,
      snapshot: {
        id: snapshotId,
        app,
        window: {
          id: windowId,
          appId: app.id,
          title: String(raw.windowTitle ?? ''),
          index,
          bounds: {
            x: Number(bounds.x),
            y: Number(bounds.y),
            width: Number(bounds.width),
            height: Number(bounds.height)
          },
          minimized: false
        },
        treeText: Array.isArray(raw.treeLines) ? raw.treeLines.join('\n') : '',
        elementCount: elements.length,
        focusedElementRef: null,
        desktopEpoch: 0
      },
      screenshot:
        typeof screenshotData === 'string' && screenshotData.length > 0 && width > 0 && height > 0
          ? {
              format: 'png',
              width,
              height,
              scale: Number(raw.screenshotScale),
              data: screenshotData
            }
          : null
    }
  }

  async inspectTarget(
    _operation: ComputerOperationName,
    input: unknown
  ): Promise<{
    bindings: ReferenceBindings
    appIdentity: { appId: string; executableId: string }
  } | null> {
    const reference = targetReference(input)
    if (reference === undefined) return null
    let current
    try {
      current = await processIdentity(reference.process.pid)
    } catch {
      return null
    }
    if (
      current.startedAt !== reference.process.startedAt ||
      current.executableId !== reference.process.executableId
    )
      return null
    return {
      bindings: { ...reference, process: current },
      appIdentity: { appId: reference.appId, executableId: current.executableId }
    }
  }

  async cancel(requestId: string): Promise<void> {
    if (!this.#pending.has(requestId)) return
    this.#child?.stdin.write(`${JSON.stringify({ type: 'cancel', requestId })}\n`)
  }

  async close(): Promise<void> {
    const child = this.#child
    this.#child = undefined
    this.#handshake = undefined
    this.#lines?.close()
    this.#lines = undefined
    this.#failAll(createComputerError('provider_crashed', 'Linux provider closed'))
    if (child === undefined) return
    child.stdin.end()
    if (child.exitCode === null) child.kill('SIGTERM')
  }
}

let activeProvider: LinuxComputerProvider | undefined

export function createProvider(): LinuxComputerProvider {
  activeProvider = new LinuxComputerProvider()
  return activeProvider
}

export async function inspectTarget(
  operation: ComputerOperationName,
  input: unknown
): Promise<{
  bindings: ReferenceBindings
  appIdentity: { appId: string; executableId: string }
} | null> {
  return activeProvider?.inspectTarget(operation, input) ?? null
}
