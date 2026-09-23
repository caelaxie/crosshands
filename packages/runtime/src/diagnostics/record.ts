import {
  COMPUTER_OPERATIONS,
  ComputerError,
  type ComputerOperationName,
  type MutationResult,
  type ReferenceBindings,
  type SnapshotResult
} from '@crosshands/contract'

export const DIAGNOSTIC_RECORD_VERSION = 1 as const

const ERROR_DETAIL_KEYS = new Set([
  'mismatches',
  'cause',
  'expectedProviderProtocol',
  'receivedProviderProtocol',
  'expectedPublicContract',
  'receivedPublicContract'
])

export type DiagnosticPlatform = 'darwin' | 'win32' | 'linux'

export type DiagnosticError = {
  code: string
  message: string
  retry: boolean
  remediation: string
  details?: Record<string, string | number | boolean | string[]>
}

export type DiagnosticTarget = {
  appId: string
  pid?: number
  windowId?: string
  snapshotId?: string
  kind?: string
  ref?: string
  toRef?: string
}

export type DiagnosticTimings = {
  queue: number
  inspect: number
  dispatch: number
  total: number
}

export type DiagnosticRequestResult =
  | {
      type: 'mutation'
      dispatched: boolean
      outcome: { state: string; reason?: string; code?: string }
      fresh?: { snapshotId: string; elementCount: number; issues: string[] }
    }
  | {
      type: 'observation'
      snapshotId?: string
      elementCount?: number
      focusedElementRef?: string | null
      screenshot: boolean
      issues: Array<{ code: string; retry: boolean; remediation: string; message?: string }>
    }
  | {
      type: 'lookup'
      appCount?: number
      windowCount?: number
      permissions?: Record<string, string>
    }
  | ({ type: 'error' } & DiagnosticError)

export type DiagnosticEnvelope = {
  v: typeof DIAGNOSTIC_RECORD_VERSION
  ts: string
  session: string
  brokerGeneration: string
  providerGeneration?: string
  desktopEpoch: number
  platform: DiagnosticPlatform
}

export type DiagnosticRecord =
  | (DiagnosticEnvelope & { kind: 'broker.start' })
  | (DiagnosticEnvelope & { kind: 'broker.stop'; reason: string })
  | (DiagnosticEnvelope & { kind: 'helper.start' })
  | (DiagnosticEnvelope & {
      kind: 'helper.crash'
      requestId?: string
      operation?: string
      error: DiagnosticError
    })
  | (DiagnosticEnvelope & { kind: 'helper.restart'; previousGeneration?: string })
  | (DiagnosticEnvelope & {
      kind: 'client.handshake'
      accepted: boolean
      requestId: string
      code?: string
    })
  | (DiagnosticEnvelope & {
      kind: 'request'
      requestId: string
      operation: string
      mutation: boolean
      ms: DiagnosticTimings
      target?: DiagnosticTarget
      key?: string
      keys?: string[]
      captureScreenshot?: boolean
      restoreWindow?: boolean
      result: DiagnosticRequestResult
    })

export type DiagnosticsSink = {
  emit(record: DiagnosticRecord): void
  close(): Promise<void>
}

export function diagnosticPlatform(
  platform: NodeJS.Platform = process.platform
): DiagnosticPlatform {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') return platform
  return 'linux'
}

export function emitDiagnostic(sink: DiagnosticsSink | undefined, record: DiagnosticRecord): void {
  try {
    sink?.emit(record)
  } catch {
    // Diagnostics must not fail computer-use.
  }
}

export function diagnosticError(cause: unknown): DiagnosticError {
  if (cause instanceof ComputerError) {
    const json = cause.toJSON()
    return {
      code: json.code,
      message: json.message,
      retry: json.retry,
      remediation: json.remediation,
      ...diagnosticErrorDetails(json.details)
    }
  }
  return {
    code: 'provider_unavailable',
    message: cause instanceof Error ? cause.message : 'Request failed',
    retry: true,
    remediation: 'run_doctor'
  }
}

export function diagnosticTarget(
  input: unknown,
  bindings: ReferenceBindings | undefined
): DiagnosticTarget | undefined {
  const appId = bindings?.appId ?? inputAppId(input)
  if (appId === undefined) return undefined
  const selector = inputSelector(input)
  return {
    appId,
    ...(bindings?.process.pid === undefined ? {} : { pid: bindings.process.pid }),
    ...(bindings?.window.id === undefined ? {} : { windowId: bindings.window.id }),
    ...(bindings?.snapshotId === undefined ? {} : { snapshotId: bindings.snapshotId }),
    ...(selector.kind === undefined ? {} : { kind: selector.kind }),
    ...(selector.ref === undefined ? {} : { ref: selector.ref }),
    ...(selector.toRef === undefined ? {} : { toRef: selector.toRef })
  }
}

export function diagnosticAct(
  operation: ComputerOperationName,
  input: unknown
): {
  key?: string
  keys?: string[]
  captureScreenshot?: boolean
  restoreWindow?: boolean
} {
  if (input === null || typeof input !== 'object') return {}
  const record = input as Record<string, unknown>
  const keys = Array.isArray(record.keys)
    ? record.keys.filter((key): key is string => typeof key === 'string')
    : []
  return {
    ...(operation === 'pressKey' && typeof record.key === 'string' ? { key: record.key } : {}),
    ...(operation === 'hotkey' && keys.length > 0 ? { keys } : {}),
    ...(typeof record.captureScreenshot === 'boolean'
      ? { captureScreenshot: record.captureScreenshot }
      : {}),
    ...(typeof record.restoreWindow === 'boolean' ? { restoreWindow: record.restoreWindow } : {})
  }
}

export function diagnosticRequestResult(
  operation: ComputerOperationName,
  result: unknown,
  dispatched: boolean | undefined
): DiagnosticRequestResult {
  if (COMPUTER_OPERATIONS[operation].mutation) {
    const mutation = result as MutationResult
    const { outcome } = mutation
    const fresh = mutation.freshState
    return {
      type: 'mutation',
      dispatched: dispatched ?? true,
      outcome: {
        state: outcome.state,
        ...('reason' in outcome && typeof outcome.reason === 'string'
          ? { reason: outcome.reason }
          : {}),
        ...((outcome.state === 'failed' || outcome.state === 'not_attempted') &&
        outcome.error !== undefined
          ? { code: outcome.error.code }
          : {})
      },
      ...(fresh === undefined
        ? {}
        : {
            fresh: {
              snapshotId: fresh.snapshot.id,
              elementCount: fresh.snapshot.elementCount,
              issues: fresh.issues.map((issue) => issue.code)
            }
          })
    }
  }
  if (operation === 'getAppState') {
    const observation = result as SnapshotResult
    return {
      type: 'observation',
      snapshotId: observation.snapshot.id,
      elementCount: observation.snapshot.elementCount,
      focusedElementRef: observation.snapshot.focusedElementRef,
      screenshot: observation.screenshot !== null,
      issues: observation.issues.map((issue) => {
        const recorded: {
          code: string
          retry: boolean
          remediation: string
          message?: string
        } = {
          code: issue.code,
          retry: issue.retry,
          remediation: issue.remediation
        }
        if (issue.message !== undefined) recorded.message = issue.message
        return recorded
      })
    }
  }
  if (operation === 'listApps') {
    return { type: 'lookup', appCount: (result as { apps: readonly unknown[] }).apps.length }
  }
  if (operation === 'listWindows') {
    return {
      type: 'lookup',
      windowCount: (result as { windows: readonly unknown[] }).windows.length
    }
  }
  if (operation === 'capabilities') {
    const body = result as {
      permissions?: Record<string, string>
      operations?: Record<string, unknown>
    }
    const operations: Record<string, boolean> = {}
    for (const [name, enabled] of Object.entries(body.operations ?? {})) {
      if (typeof enabled === 'boolean') operations[name] = enabled
    }
    return {
      type: 'lookup',
      ...(body.permissions === undefined ? {} : { permissions: body.permissions }),
      ...(Object.keys(operations).length > 0 ? { operations } : {})
    }
  }
  if (operation === 'permissions') {
    const permissions = (result as { permissions: Record<string, string> }).permissions
    return { type: 'lookup', permissions }
  }
  return { type: 'lookup' }
}

function diagnosticErrorDetails(
  details: unknown
): { details: NonNullable<DiagnosticError['details']> } | Record<string, never> {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return {}
  const result: NonNullable<DiagnosticError['details']> = {}
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (!ERROR_DETAIL_KEYS.has(key)) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value
    } else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      result[key] = value
    }
  }
  return Object.keys(result).length > 0 ? { details: result } : {}
}

function inputAppId(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const app = (input as { app?: unknown }).app
  return typeof app === 'string' && app.length > 0 ? app : undefined
}

function selectorRef(selector: unknown): { kind?: string; ref?: string } {
  if (selector === null || typeof selector !== 'object') return {}
  const target = selector as { kind?: unknown; elementIndex?: unknown; ref?: unknown }
  let kind = typeof target.kind === 'string' ? target.kind : undefined
  let ref: string | undefined
  if (typeof target.elementIndex === 'number') ref = `element:${target.elementIndex}`
  if (typeof target.ref === 'string') {
    ref = target.ref
  } else if (target.ref !== null && typeof target.ref === 'object') {
    const bound = target.ref as { kind?: unknown; ref?: unknown }
    if (typeof bound.kind === 'string') kind = bound.kind
    if (typeof bound.ref === 'string') ref = bound.ref
  }
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(ref === undefined ? {} : { ref })
  }
}

function inputSelector(input: unknown): { kind?: string; ref?: string; toRef?: string } {
  if (input === null || typeof input !== 'object') return {}
  const record = input as { target?: unknown; from?: unknown; to?: unknown }
  const main = selectorRef(record.target ?? record.from)
  const to = selectorRef(record.to)
  return {
    ...main,
    ...(to.ref === undefined ? {} : { toRef: to.ref })
  }
}
