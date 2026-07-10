import type { ComputerOperationName } from '@crosshands/contract'

export type StableAppIdentity = {
  appId: string
  executableId: string
  publisher?: string
}

export type AppClassification = 'allowed' | 'sensitive'

const SENSITIVE_IDENTIFIERS = [
  '1password',
  'bitwarden',
  'keychainaccess',
  'keepass',
  'lastpass',
  'proton.pass',
  'secrets'
] as const

export function classifyApp(identity: StableAppIdentity): AppClassification {
  const stableIdentity =
    `${identity.appId}\n${identity.executableId}\n${identity.publisher ?? ''}`.toLowerCase()
  return SENSITIVE_IDENTIFIERS.some((identifier) => stableIdentity.includes(identifier))
    ? 'sensitive'
    : 'allowed'
}

export function assertAppAllowed(identity: StableAppIdentity): void {
  if (classifyApp(identity) === 'sensitive') {
    const error = new Error('Sensitive applications are blocked by default')
    Object.assign(error, {
      code: 'app_blocked',
      retry: false,
      remediation: 'choose_non_sensitive_target'
    })
    throw error
  }
}

const PROTECTED_ROLES = new Set(['password', 'securetext', 'secret', 'credential'])

export function redactProtectedContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactProtectedContent)
  if (value === null || typeof value !== 'object') return value

  const record = value as Record<string, unknown>
  if (record.protected === true) return '[REDACTED]'
  const protectedRole =
    typeof record.role === 'string' && PROTECTED_ROLES.has(record.role.toLowerCase())
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) {
    const sensitiveKey = /^(value|text|password|secret|token|clipboard|data)$/i.test(key)
    result[key] = protectedRole && sensitiveKey ? '[REDACTED]' : redactProtectedContent(entry)
  }
  return result
}

export type DiagnosticEntry =
  | { event: 'operation'; operation: ComputerOperationName }
  | { event: 'error'; message: string }

export class SecretSafeDiagnostics {
  readonly entries: DiagnosticEntry[] = []

  operation(operation: ComputerOperationName, _input: unknown): void {
    this.entries.push({ event: 'operation', operation })
  }

  error(message: string, _cause?: unknown): void {
    this.entries.push({ event: 'error', message })
  }
}
