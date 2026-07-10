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

export type ComputerErrorCode = keyof typeof ERROR_CATALOG
export type ComputerErrorRemediation = (typeof ERROR_CATALOG)[ComputerErrorCode]['remediation']

export const ComputerErrorCodeSchema = z.enum(
  Object.keys(ERROR_CATALOG) as [ComputerErrorCode, ...ComputerErrorCode[]]
)

export const SerializedComputerErrorSchema = z
  .object({
    code: ComputerErrorCodeSchema,
    message: z.string().min(1),
    retry: z.boolean(),
    remediation: z.string().min(1),
    details: z.unknown().optional()
  })
  .strict()

export type SerializedComputerError = z.infer<typeof SerializedComputerErrorSchema>

export class ComputerError extends Error {
  readonly code: ComputerErrorCode
  readonly retry: boolean
  readonly remediation: ComputerErrorRemediation
  readonly details: unknown

  constructor(code: ComputerErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'ComputerError'
    this.code = code
    this.retry = ERROR_CATALOG[code].retry
    this.remediation = ERROR_CATALOG[code].remediation
    this.details = details
  }

  toJSON(): SerializedComputerError {
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
}

export function createComputerError(
  code: ComputerErrorCode,
  message: string,
  details?: unknown
): ComputerError {
  return new ComputerError(code, message, details)
}
