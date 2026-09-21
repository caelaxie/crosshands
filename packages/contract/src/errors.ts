import { z } from 'zod'

export const ERROR_CATALOG = {
  app_not_found: { retry: true, remediation: 'refresh_apps' },
  app_unavailable: { retry: true, remediation: 'refresh_apps' },
  app_blocked: { retry: false, remediation: 'choose_non_sensitive_target' },
  window_not_found: { retry: true, remediation: 'refresh_windows' },
  window_unavailable: { retry: true, remediation: 'refresh_windows' },
  window_not_focused: { retry: true, remediation: 'focus_window' },
  permission_denied: { retry: false, remediation: 'grant_permission' },
  stale_target: { retry: true, remediation: 'refresh_state' },
  element_not_found: { retry: true, remediation: 'refresh_state' },
  element_not_clickable: { retry: true, remediation: 'choose_actionable_target' },
  action_not_supported: { retry: false, remediation: 'choose_supported_operation' },
  value_not_settable: { retry: false, remediation: 'choose_settable_target' },
  invalid_argument: { retry: false, remediation: 'correct_request' },
  timeout: { retry: false, remediation: 'inspect_state_before_retry' },
  unsupported_capability: { retry: false, remediation: 'choose_supported_operation' },
  provider_unavailable: { retry: true, remediation: 'run_doctor' },
  provider_crashed: { retry: true, remediation: 'refresh_state' },
  version_incompatible: { retry: false, remediation: 'upgrade_or_downgrade' },
  interaction_context_invalid: { retry: true, remediation: 'refresh_state' },
  interaction_context_expired: { retry: true, remediation: 'refresh_state' },
  session_unavailable: { retry: true, remediation: 'unlock_graphical_session' },
  screenshot_failed: { retry: true, remediation: 'check_screenshot_permission' },
  accessibility_error: { retry: true, remediation: 'check_accessibility_permission' }
} as const

export const PUBLIC_ERROR_CATALOG = {
  goal_mismatch: { retry: true, remediation: 'refresh_state' },
  policy_unavailable: { retry: true, remediation: 'refresh_state' },
  intent_unavailable: { retry: false, remediation: 'correct_request' }
} as const

const COMBINED_ERROR_CATALOG = {
  ...ERROR_CATALOG,
  ...PUBLIC_ERROR_CATALOG
} as const

export type ComputerErrorCode = keyof typeof ERROR_CATALOG
export type PublicErrorCode = keyof typeof PUBLIC_ERROR_CATALOG
export type PublicComputerErrorCode = ComputerErrorCode | PublicErrorCode
export type ComputerErrorRemediation =
  (typeof COMBINED_ERROR_CATALOG)[PublicComputerErrorCode]['remediation']

function errorCodeSchema<T extends string>(catalog: Record<T, unknown>): z.ZodEnum<Record<T, T>> {
  const codes = Object.keys(catalog) as [T, ...T[]]
  return z.enum(codes)
}

export const ComputerErrorCodeSchema = errorCodeSchema(ERROR_CATALOG)
export const PublicComputerErrorCodeSchema = errorCodeSchema(COMBINED_ERROR_CATALOG)

function serializedErrorSchema<T extends z.ZodEnum<Record<string, string>>>(code: T) {
  return z
    .object({
      code,
      message: z.string().min(1),
      retry: z.boolean(),
      remediation: z.string().min(1),
      details: z.unknown().optional()
    })
    .strict()
}

export const SerializedComputerErrorSchema = serializedErrorSchema(ComputerErrorCodeSchema)
export const PublicSerializedComputerErrorSchema = serializedErrorSchema(
  PublicComputerErrorCodeSchema
)

export type SerializedComputerError = z.infer<typeof SerializedComputerErrorSchema>
export type PublicSerializedComputerError = z.infer<typeof PublicSerializedComputerErrorSchema>

export class ComputerError extends Error {
  readonly code: PublicComputerErrorCode
  readonly retry: boolean
  readonly remediation: ComputerErrorRemediation
  readonly details: unknown

  constructor(code: PublicComputerErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'ComputerError'
    this.code = code
    this.retry = COMBINED_ERROR_CATALOG[code].retry
    this.remediation = COMBINED_ERROR_CATALOG[code].remediation
    this.details = details
  }

  toJSON(): PublicSerializedComputerError {
    return this.details === undefined
      ? { code: this.code, message: this.message, retry: this.retry, remediation: this.remediation }
      : {
          code: this.code,
          message: this.message,
          retry: this.retry,
          remediation: this.remediation,
          details: this.details
        }
  }

  toBrokerJSON(): SerializedComputerError {
    return SerializedComputerErrorSchema.parse(this.toJSON())
  }
}

export function createComputerError(
  code: PublicComputerErrorCode,
  message: string,
  details?: unknown
): ComputerError {
  return new ComputerError(code, message, details)
}
