import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { isAbsolute, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COMPUTER_OPERATIONS,
  CONTRACT_VERSIONS,
  createComputerError,
  type ComputerOperationName,
  type ComputerProvider,
  type ProviderHandshake,
  type ProviderRequest,
  type ProviderResponse,
  type ReferenceBindings
} from '@crosshands/contract'
import type { StableAppIdentity } from '@crosshands/runtime'

type JsonRecord = Record<string, unknown>

type NativeProcessIdentity = {
  pid: number
  startedAt: string
  sessionId: number
  desktop: string
  executablePath: string
  integrityRid: number
  publisher: string
  sha256: string
}

export type NativeFrame = { ok: boolean; error?: string } & JsonRecord

export type PowerShellLaunchSpec = {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export function windowsPowerShellLaunchSpec(
  scriptPath: string,
  env: NodeJS.ProcessEnv = process.env
): PowerShellLaunchSpec {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  const executable = win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const absoluteScript = win32.isAbsolute(scriptPath)
    ? win32.normalize(scriptPath)
    : win32.resolve(scriptPath)
  return {
    executable,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      absoluteScript
    ],
    env: {
      SystemRoot: systemRoot,
      WINDIR: env.WINDIR ?? systemRoot,
      TEMP: env.TEMP ?? win32.join(systemRoot, 'Temp'),
      TMP: env.TMP ?? env.TEMP ?? win32.join(systemRoot, 'Temp'),
      USERPROFILE: env.USERPROFILE,
      LOCALAPPDATA: env.LOCALAPPDATA,
      APPDATA: env.APPDATA,
      PSModuleAutoLoadingPreference: 'None',
      POWERSHELL_TELEMETRY_OPTOUT: '1'
    }
  }
}

export interface NativeWindowsTransport {
  start(): Promise<NativeFrame>
  request(payload: JsonRecord, deadlineAt: number): Promise<NativeFrame>
  cancel(): Promise<void>
  close(): Promise<void>
}

export class PowerShellStdioTransport implements NativeWindowsTransport {
  readonly #launch: PowerShellLaunchSpec
  #child: ChildProcessWithoutNullStreams | undefined
  #ready: Promise<NativeFrame> | undefined
  #resolveReady: ((frame: NativeFrame) => void) | undefined
  #rejectReady: ((cause: unknown) => void) | undefined
  #active:
    | { resolve(frame: NativeFrame): void; reject(cause: unknown): void; timer: NodeJS.Timeout }
    | undefined
  #tail: Promise<void> = Promise.resolve()

  constructor(scriptPath: string) {
    this.#launch = windowsPowerShellLaunchSpec(scriptPath)
  }

  async start(): Promise<NativeFrame> {
    if (this.#ready !== undefined) return this.#ready
    this.#ready = new Promise<NativeFrame>((resolveReady, rejectReady) => {
      this.#resolveReady = resolveReady
      this.#rejectReady = rejectReady
    })
    const child = spawn(this.#launch.executable, this.#launch.args, {
      env: this.#launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    })
    this.#child = child
    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })
    lines.on('line', (line) => this.#receive(line))
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 8_192) stderr += chunk.slice(0, 8_192 - stderr.length)
    })
    child.once('error', (cause) => this.#fail(cause, child))
    child.once('exit', (code) =>
      this.#fail(
        createComputerError(
          'provider_crashed',
          `Windows provider exited with code ${String(code)}`,
          {
            stderr
          }
        ),
        child
      )
    )
    return this.#ready
  }

  request(payload: JsonRecord, deadlineAt: number): Promise<NativeFrame> {
    const result = this.#tail.then(async () => {
      await this.start()
      if (deadlineAt <= Date.now()) throw createComputerError('timeout', 'Request deadline elapsed')
      const child = this.#child
      if (child === undefined || !child.stdin.writable)
        throw createComputerError('provider_unavailable', 'Windows provider stdin is unavailable')
      return new Promise<NativeFrame>((resolveFrame, rejectFrame) => {
        const timer = setTimeout(
          () => {
            this.#active = undefined
            if (this.#child === child) {
              this.#child = undefined
              this.#ready = undefined
              this.#resolveReady = undefined
              this.#rejectReady = undefined
            }
            child.kill()
            rejectFrame(createComputerError('timeout', 'Windows provider request timed out'))
          },
          Math.max(1, deadlineAt - Date.now())
        )
        timer.unref()
        this.#active = { resolve: resolveFrame, reject: rejectFrame, timer }
        child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', (cause) => {
          if (cause !== null && cause !== undefined) this.#fail(cause, child)
        })
      })
    })
    this.#tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async cancel(): Promise<void> {
    this.#child?.kill()
  }

  async close(): Promise<void> {
    const child = this.#child
    this.#child = undefined
    this.#ready = undefined
    this.#resolveReady = undefined
    this.#rejectReady = undefined
    child?.stdin.end()
    child?.kill()
  }

  #receive(line: string): void {
    let frame: NativeFrame
    try {
      frame = JSON.parse(line) as NativeFrame
    } catch {
      this.#fail(
        createComputerError('provider_crashed', 'Windows provider emitted non-JSON stdout')
      )
      return
    }
    if (this.#resolveReady !== undefined) {
      const resolveReady = this.#resolveReady
      this.#resolveReady = undefined
      this.#rejectReady = undefined
      resolveReady(frame)
      return
    }
    const active = this.#active
    if (active === undefined) {
      this.#fail(
        createComputerError('provider_crashed', 'Windows provider emitted an unsolicited frame')
      )
      return
    }
    this.#active = undefined
    clearTimeout(active.timer)
    active.resolve(frame)
  }

  #fail(cause: unknown, source?: ChildProcessWithoutNullStreams): void {
    if (source !== undefined && this.#child !== source) return
    this.#child = undefined
    this.#ready = undefined
    const rejectReady = this.#rejectReady
    this.#resolveReady = undefined
    this.#rejectReady = undefined
    rejectReady?.(cause)
    const active = this.#active
    this.#active = undefined
    if (active !== undefined) {
      clearTimeout(active.timer)
      active.reject(cause)
    }
  }
}

type WindowsProviderOptions = {
  scriptPath?: string
  manifestPath?: string
  transport?: NativeWindowsTransport
  graphicalSessionId?: string
  skipPayloadVerification?: boolean
}

const PACKAGED_SCRIPT = fileURLToPath(new URL('../assets/runtime.ps1', import.meta.url))
const PACKAGED_MANIFEST = fileURLToPath(new URL('../assets/payload.json', import.meta.url))

export async function verifyWindowsPayload(
  scriptPath = PACKAGED_SCRIPT,
  manifestPath = PACKAGED_MANIFEST
): Promise<void> {
  if (!isAbsolute(scriptPath) || !isAbsolute(manifestPath)) {
    throw createComputerError('provider_unavailable', 'Windows payload paths must be absolute')
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    productVersion?: unknown
    files?: Record<string, unknown>
  }
  if (manifest.productVersion !== CONTRACT_VERSIONS.product) {
    throw createComputerError('version_incompatible', 'Windows payload product version mismatch')
  }
  const expected = manifest.files?.['runtime.ps1']
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
    throw createComputerError('provider_unavailable', 'Windows payload manifest is malformed')
  }
  const actual = createHash('sha256')
    .update(await readFile(scriptPath))
    .digest('hex')
  if (actual !== expected) {
    throw createComputerError('provider_unavailable', 'Windows provider payload hash mismatch')
  }
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' ? (value as JsonRecord) : {}
}

function errorCode(message: string): Parameters<typeof createComputerError>[0] {
  const normalized = message.toLowerCase()
  if (normalized.includes('appblocked')) return 'app_blocked'
  if (normalized.includes('appnotfound')) return 'app_not_found'
  if (normalized.includes('windownotfound')) return 'window_not_found'
  if (normalized.includes('window_not_focused')) return 'window_not_focused'
  if (normalized.includes('stale_target') || normalized.includes('stale element'))
    return 'stale_target'
  if (normalized.includes('session_unavailable')) return 'session_unavailable'
  if (normalized.includes('unsupported_capability')) return 'unsupported_capability'
  if (normalized.includes('not settable')) return 'value_not_settable'
  if (normalized.includes('unknown element')) return 'element_not_found'
  if (normalized.includes('unsupported')) return 'action_not_supported'
  return 'accessibility_error'
}

function isPreDispatchFailure(message: string): boolean {
  return /^(app|window).*notfound|appblocked|session_unavailable|unsupported_capability|stale_target|window_not_focused/i.test(
    message
  )
}

function executableId(identity: NativeProcessIdentity): string {
  const raw = `${identity.executablePath}|il:${identity.integrityRid}|pub:${identity.publisher}|sha256:${identity.sha256}`
  return raw.length <= 512 ? raw : `sha256:${createHash('sha256').update(raw).digest('hex')}`
}

function targetReference(input: JsonRecord): JsonRecord {
  const candidates = [input.target, input.from, input.to]
  for (const candidate of candidates) {
    const candidateRecord = record(candidate)
    if (candidateRecord.kind === 'element') return record(candidateRecord.ref)
    if ('contextToken' in candidateRecord) return candidateRecord
    if (candidateRecord.kind === 'coordinate') return record(candidateRecord.window)
  }
  return {}
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > 32) {
    const oldest = map.keys().next().value as K | undefined
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

export class WindowsComputerProvider implements ComputerProvider {
  readonly generation = `windows-${randomUUID()}`
  readonly #transport: NativeWindowsTransport
  readonly #graphicalSessionId: string
  readonly #scriptPath: string
  readonly #manifestPath: string
  readonly #skipPayloadVerification: boolean
  readonly #snapshots = new Map<string, JsonRecord>()
  readonly #identities = new Map<string, NativeProcessIdentity>()
  #handshake: ProviderHandshake | undefined

  constructor(options: WindowsProviderOptions = {}) {
    this.#scriptPath = options.scriptPath ?? PACKAGED_SCRIPT
    this.#manifestPath = options.manifestPath ?? PACKAGED_MANIFEST
    this.#skipPayloadVerification =
      options.skipPayloadVerification ?? options.transport !== undefined
    this.#transport = options.transport ?? new PowerShellStdioTransport(this.#scriptPath)
    this.#graphicalSessionId =
      options.graphicalSessionId ??
      process.env.CROSSHANDS_GRAPHICAL_SESSION_ID ??
      process.env.SESSIONNAME ??
      'win32:interactive'
  }

  async start(): Promise<ProviderHandshake> {
    if (this.#handshake !== undefined) return this.#handshake
    if (!this.#skipPayloadVerification) {
      await verifyWindowsPayload(this.#scriptPath, this.#manifestPath)
    }
    const ready = await this.#transport.start()
    if (!ready.ok || ready.ready !== true)
      throw createComputerError('provider_unavailable', 'Windows provider readiness failed')
    this.#handshake = {
      provider: 'crosshands-platform-windows',
      generation: this.generation,
      graphicalSessionId: this.#graphicalSessionId,
      providerProtocol: CONTRACT_VERSIONS.providerProtocol,
      publicContract: CONTRACT_VERSIONS.publicContract,
      capabilities: {
        platform: 'win32',
        provider: 'crosshands-platform-windows',
        providerVersion: CONTRACT_VERSIONS.product,
        operations: Object.fromEntries(
          Object.keys(COMPUTER_OPERATIONS).map((operation) => [operation, true])
        ),
        permissions: { accessibility: 'not_required', screenshots: 'not_required' }
      }
    }
    return this.#handshake
  }

  async dispatch(request: ProviderRequest): Promise<ProviderResponse> {
    await this.start()
    if (request.operation === 'capabilities')
      return {
        requestId: request.requestId,
        dispatched: false,
        result: this.#handshake!.capabilities
      }
    if (request.operation === 'permissions')
      return {
        requestId: request.requestId,
        dispatched: false,
        result: { permissions: this.#handshake!.capabilities.permissions }
      }
    const input = record(request.input)
    const nativeInput = this.#nativeInput(request.operation, input)
    const frame = await this.#transport.request(nativeInput, request.deadlineAt)
    if (!frame.ok) {
      const message = frame.error ?? 'Windows provider operation failed'
      const dispatched = COMPUTER_OPERATIONS[request.operation].mutation
        ? !isPreDispatchFailure(message)
        : false
      return {
        requestId: request.requestId,
        dispatched,
        error: createComputerError(errorCode(message), message).toJSON()
      }
    }
    return {
      requestId: request.requestId,
      dispatched: COMPUTER_OPERATIONS[request.operation].mutation,
      result: this.#normalizeResult(request.operation, frame)
    }
  }

  async inspect(
    operation: ComputerOperationName,
    input: unknown
  ): Promise<{
    bindings: ReferenceBindings
    appIdentity: StableAppIdentity
  } | null> {
    if (!COMPUTER_OPERATIONS[operation].mutation) return null
    const inputRecord = record(input)
    const reference = targetReference(inputRecord)
    const app = String(inputRecord.app ?? reference.appId ?? '')
    if (app.length === 0) return null
    await this.start()
    const frame = await this.#transport.request({ tool: 'inspect_target', app }, Date.now() + 5_000)
    if (!frame.ok)
      throw createComputerError(errorCode(frame.error ?? ''), frame.error ?? 'Inspect failed')
    const identity = frame.identity as NativeProcessIdentity
    setBounded(this.#identities, app, identity)
    const nativeExecutableId = executableId(identity)
    return {
      bindings: {
        brokerGeneration: String(reference.brokerGeneration ?? 'unbound'),
        providerGeneration: this.generation,
        graphicalSessionId: this.#graphicalSessionId,
        process: {
          pid: identity.pid,
          startedAt: identity.startedAt,
          executableId: nativeExecutableId
        },
        appId: String(frame.appId),
        window: { id: String(frame.windowId), ownerPid: identity.pid },
        snapshotId: String(reference.snapshotId ?? 'inspection'),
        desktopEpoch: Number(reference.desktopEpoch ?? 0)
      },
      appIdentity: { appId: String(frame.appId), executableId: nativeExecutableId }
    }
  }

  async cancel(_requestId: string): Promise<void> {
    await this.#transport.cancel()
  }

  async close(): Promise<void> {
    this.#handshake = undefined
    this.#snapshots.clear()
    this.#identities.clear()
    await this.#transport.close()
  }

  #nativeInput(operation: ComputerOperationName, input: JsonRecord): JsonRecord {
    const toolNames: Partial<Record<ComputerOperationName, string>> = {
      listApps: 'list_apps',
      listWindows: 'list_windows',
      getAppState: 'get_app_state',
      performSecondaryAction: 'perform_secondary_action',
      typeText: 'type_text',
      pressKey: 'press_key',
      pasteText: 'paste_text',
      setValue: 'set_value'
    }
    const tool = toolNames[operation] ?? operation
    const reference = targetReference(input)
    const app = String(input.app ?? reference.appId ?? '')
    const cached = this.#snapshots.get(app)
    const target = record(input.target)
    const from = record(input.from)
    const to = record(input.to)
    const elementFor = (candidate: JsonRecord): unknown => {
      if (candidate.kind !== 'element') return undefined
      const ref = record(candidate.ref)
      const index = Number(String(ref.ref ?? '').replace(/^element:/, ''))
      const elements = Array.isArray(cached?.elements) ? cached.elements : []
      return Number.isInteger(index) ? elements[index] : undefined
    }
    return {
      tool,
      app,
      noScreenshot: input.captureScreenshot === false,
      restoreWindow: input.restoreWindow === true,
      expectedIdentity: this.#identities.get(app),
      windowId: reference.window !== undefined ? record(reference.window).id : cached?.windowId,
      windowBounds: cached?.windowBounds,
      element: elementFor(target),
      fromElement: elementFor(from),
      toElement: elementFor(to),
      x: target.x,
      y: target.y,
      from_x: from.x,
      from_y: from.y,
      to_x: to.x,
      to_y: to.y,
      duration_ms: input.durationMs,
      click_count: input.clickCount,
      mouse_button: input.button,
      action: input.action,
      direction: input.direction,
      pages: input.pages,
      text: input.text,
      key: Array.isArray(input.keys) ? input.keys.join('+') : input.key,
      value: input.value,
      ...(operation === 'getAppState'
        ? {
            windowId: record(input.window).id,
            windowIndex: record(input.window).index
          }
        : {})
    }
  }

  #normalizeResult(operation: ComputerOperationName, frame: NativeFrame): unknown {
    if (operation === 'listApps') {
      return {
        apps: (Array.isArray(frame.apps) ? frame.apps : []).map((value) => {
          const app = record(value)
          return {
            id: String(app.bundleId),
            name: String(app.name),
            bundleId: String(app.bundleId),
            pid: Number(app.pid),
            isRunning: true
          }
        })
      }
    }
    if (operation === 'listWindows') {
      return {
        windows: (Array.isArray(frame.windows) ? frame.windows : []).map((value) => {
          const window = record(value)
          const app = record(window.app)
          return {
            id: String(window.id),
            appId: String(app.bundleId),
            title: String(window.title ?? ''),
            index: Number(window.index),
            bounds: {
              x: Number(window.x ?? 0),
              y: Number(window.y ?? 0),
              width: Math.max(1, Number(window.width ?? 1)),
              height: Math.max(1, Number(window.height ?? 1))
            },
            minimized: Boolean(window.isMinimized)
          }
        })
      }
    }
    if (operation === 'getAppState') return this.#snapshotResult(record(frame.snapshot))
    const action = record(frame.action)
    const verification = record(action.verification)
    return {
      outcome:
        verification.state === 'verified'
          ? { state: 'verified', evidence: verification }
          : {
              state: 'indeterminate',
              reason: String(verification.reason ?? 'native_action_unverified')
            },
      freshState: this.#snapshotResult(record(frame.snapshot))
    }
  }

  #snapshotResult(native: JsonRecord): unknown {
    const app = record(native.app)
    const identity = native.processIdentity as NativeProcessIdentity
    const bounds = record(native.windowBounds)
    const appId = String(app.bundleId)
    setBounded(this.#snapshots, appId, native)
    setBounded(this.#identities, appId, identity)
    const snapshot = {
      id: String(native.snapshotId),
      app: {
        id: appId,
        name: String(app.name),
        bundleId: appId,
        pid: Number(app.pid),
        isRunning: true
      },
      window: {
        id: String(native.windowId),
        appId,
        title: String(native.windowTitle ?? ''),
        index: 0,
        bounds: {
          x: Number(bounds.x ?? 0),
          y: Number(bounds.y ?? 0),
          width: Math.max(1, Number(bounds.width ?? 1)),
          height: Math.max(1, Number(bounds.height ?? 1))
        },
        minimized: false
      },
      treeText: (Array.isArray(native.treeLines) ? native.treeLines : []).join('\n'),
      elementCount: Array.isArray(native.elements) ? native.elements.length : 0,
      focusedElementRef:
        native.focusedElementId === null || native.focusedElementId === undefined
          ? null
          : String(native.focusedElementId),
      desktopEpoch: 0
    }
    return {
      bindings: {
        brokerGeneration: 'unbound',
        providerGeneration: this.generation,
        graphicalSessionId: this.#graphicalSessionId,
        process: {
          pid: identity.pid,
          startedAt: identity.startedAt,
          executableId: executableId(identity)
        },
        appId,
        window: { id: String(native.windowId), ownerPid: identity.pid },
        snapshotId: String(native.snapshotId),
        desktopEpoch: 0
      },
      snapshot,
      screenshot:
        typeof native.screenshotPngBase64 === 'string'
          ? {
              format: 'png',
              width: Number(native.screenshotWidth),
              height: Number(native.screenshotHeight),
              scale: Number(native.screenshotScale),
              data: native.screenshotPngBase64
            }
          : null,
      issues: normalizeScreenshotIssues(native.screenshotError)
    }
  }
}

export function normalizeScreenshotIssues(value: unknown): JsonRecord[] {
  const error = record(value)
  if (typeof error.message !== 'string' || error.message.length === 0) return []
  return [
    createComputerError('screenshot_failed', error.message, { component: 'screenshots' }).toJSON()
  ]
}
