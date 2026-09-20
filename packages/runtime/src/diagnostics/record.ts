import {
  COMPUTER_OPERATIONS,
  type ComputerOperationName,
  type ReferenceBindings
} from '@crosshands/contract'

export const DIAGNOSTIC_RECORD_VERSION = 1 as const

const FORBIDDEN_KEYS = new Set([
  'text',
  'value',
  'password',
  'secret',
  'token',
  'clipboard',
  'data',
  'treetext',
  'contexttoken',
  'evidence',
  'title'
])

export type DiagnosticPlatform = 'darwin' | 'win32' | 'linux'

export type DiagnosticError = {
  code: string
  message: string
  retry: boolean
  remediation: string
  details?: unknown
}

export type DiagnosticTarget = {
  appId: string
  pid?: number
  windowId?: string
  snapshotId?: string
  kind?: string
  ref?: string
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
      outcome: { state: string; reason?: string }
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

type Envelope = {
  v: typeof DIAGNOSTIC_RECORD_VERSION
  ts: string
  session: string
  brokerGeneration: string
  providerGeneration?: string
  desktopEpoch: number
  platform: DiagnosticPlatform
}

export type DiagnosticRecord =
  | (Envelope & { kind: 'broker.start' })
  | (Envelope & { kind: 'broker.stop'; reason: string })
  | (Envelope & { kind: 'helper.start' })
  | (Envelope & {
      kind: 'helper.crash'
      requestId?: string
      operation?: string
      error: DiagnosticError
    })
  | (Envelope & { kind: 'helper.restart'; previousGeneration?: string })
  | (Envelope & {
      kind: 'client.handshake'
      accepted: boolean
      requestId: string
      code?: string
    })
  | (Envelope & {
      kind: 'request'
      requestId: string
      operation: string
      mutation: boolean
      ms: DiagnosticTimings
      target?: DiagnosticTarget
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

export function isMutationOperation(operation: ComputerOperationName): boolean {
  return COMPUTER_OPERATIONS[operation].mutation
}

export function omitForbidden(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitForbidden)
  if (value === null || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) continue
    result[key] = omitForbidden(entry)
  }
  return result
}

export function diagnosticError(cause: unknown): DiagnosticError {
  if (cause !== null && typeof cause === 'object') {
    const record = cause as Record<string, unknown>
    const serialized =
      typeof record.toJSON === 'function' ? (record.toJSON as () => unknown)() : record
    if (serialized !== null && typeof serialized === 'object') {
      const error = serialized as Record<string, unknown>
      return {
        code: typeof error.code === 'string' ? error.code : 'provider_unavailable',
        message: typeof error.message === 'string' ? error.message : 'Request failed',
        retry: typeof error.retry === 'boolean' ? error.retry : false,
        remediation: typeof error.remediation === 'string' ? error.remediation : 'run_doctor',
        ...(error.details === undefined ? {} : { details: omitForbidden(error.details) })
      }
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
  const record =
    input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const appId =
    bindings?.appId ??
    (typeof record.app === 'string' && record.app.length > 0 ? record.app : undefined)
  if (appId === undefined) return undefined
  const selector = record.target ?? record.from
  let kind: string | undefined
  let ref: string | undefined
  if (selector !== null && typeof selector === 'object') {
    const target = selector as Record<string, unknown>
    if (typeof target.kind === 'string') kind = target.kind
    if (typeof target.elementIndex === 'number') ref = `element:${target.elementIndex}`
    if (typeof target.ref === 'string') ref = target.ref
    if (target.ref !== null && typeof target.ref === 'object') {
      const bound = target.ref as Record<string, unknown>
      if (typeof bound.kind === 'string') kind = bound.kind
      if (typeof bound.ref === 'string') ref = bound.ref
    }
  }
  return {
    appId,
    ...(bindings?.process.pid === undefined ? {} : { pid: bindings.process.pid }),
    ...(bindings?.window.id === undefined ? {} : { windowId: bindings.window.id }),
    ...(bindings?.snapshotId === undefined ? {} : { snapshotId: bindings.snapshotId }),
    ...(kind === undefined ? {} : { kind }),
    ...(ref === undefined ? {} : { ref })
  }
}

export function diagnosticRequestResult(
  _operation: ComputerOperationName,
  result: unknown,
  dispatched: boolean | undefined
): DiagnosticRequestResult {
  if (result === null || typeof result !== 'object') {
    return { type: 'lookup' }
  }
  const value = result as Record<string, unknown>
  if (value.outcome !== null && typeof value.outcome === 'object') {
    const outcome = value.outcome as Record<string, unknown>
    return {
      type: 'mutation',
      dispatched: dispatched ?? true,
      outcome: {
        state: typeof outcome.state === 'string' ? outcome.state : 'indeterminate',
        ...(typeof outcome.reason === 'string' ? { reason: outcome.reason } : {})
      }
    }
  }
  if (value.snapshot !== null && typeof value.snapshot === 'object') {
    const snapshot = value.snapshot as Record<string, unknown>
    const issues = Array.isArray(value.issues)
      ? value.issues.flatMap((issue) => {
          if (issue === null || typeof issue !== 'object') return []
          const record = issue as Record<string, unknown>
          if (typeof record.code !== 'string') return []
          return [
            {
              code: record.code,
              retry: typeof record.retry === 'boolean' ? record.retry : false,
              remediation:
                typeof record.remediation === 'string' ? record.remediation : 'run_doctor',
              ...(typeof record.message === 'string' ? { message: record.message } : {})
            }
          ]
        })
      : []
    return {
      type: 'observation',
      ...(typeof snapshot.id === 'string' ? { snapshotId: snapshot.id } : {}),
      ...(typeof snapshot.elementCount === 'number' ? { elementCount: snapshot.elementCount } : {}),
      focusedElementRef:
        snapshot.focusedElementRef === null || typeof snapshot.focusedElementRef === 'string'
          ? snapshot.focusedElementRef
          : null,
      screenshot: value.screenshot !== null && value.screenshot !== undefined,
      issues
    }
  }
  const permissions: Record<string, string> = {}
  if (value.permissions !== null && typeof value.permissions === 'object') {
    for (const [key, entry] of Object.entries(value.permissions as Record<string, unknown>)) {
      if (typeof entry === 'string') permissions[key] = entry
    }
  }
  return {
    type: 'lookup',
    ...(Array.isArray(value.apps) ? { appCount: value.apps.length } : {}),
    ...(Array.isArray(value.windows) ? { windowCount: value.windows.length } : {}),
    ...(Object.keys(permissions).length > 0 ? { permissions } : {})
  }
}
