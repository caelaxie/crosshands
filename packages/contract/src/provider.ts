import { z } from 'zod'

import type { SerializedComputerError } from './errors.js'
import type { ComputerOperationName } from './operations.js'
import { ProviderHandshakeSchema } from './schemas.js'

export const ProviderRequestSchema = z
  .object({
    requestId: z.string().min(1),
    operation: z.enum([
      'capabilities',
      'permissions',
      'listApps',
      'listWindows',
      'getAppState',
      'click',
      'performSecondaryAction',
      'scroll',
      'drag',
      'typeText',
      'pressKey',
      'hotkey',
      'pasteText',
      'setValue'
    ]),
    input: z.unknown(),
    deadlineAt: z.number()
  })
  .strict()

export const ProviderResponseSchema = z.union([
  z
    .object({
      requestId: z.string().min(1),
      dispatched: z.boolean(),
      result: z.unknown()
    })
    .strict(),
  z
    .object({
      requestId: z.string().min(1),
      dispatched: z.boolean(),
      error: z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
          retry: z.boolean(),
          remediation: z.string().min(1),
          details: z.unknown().optional()
        })
        .strict()
    })
    .strict()
])

export const ProviderProtocolFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('handshake'), payload: ProviderHandshakeSchema }).strict(),
  z.object({ type: z.literal('request'), payload: ProviderRequestSchema }).strict(),
  z.object({ type: z.literal('response'), payload: ProviderResponseSchema }).strict(),
  z.object({ type: z.literal('cancel'), requestId: z.string().min(1) }).strict()
])

export type ProviderRequest = {
  requestId: string
  operation: ComputerOperationName
  input: unknown
  deadlineAt: number
}

export type ProviderResponse =
  | { requestId: string; dispatched: boolean; result: unknown; error?: never }
  | { requestId: string; dispatched: boolean; result?: never; error: SerializedComputerError }

export type ProviderHandshake = z.infer<typeof ProviderHandshakeSchema>

export interface ComputerProvider {
  readonly generation: string
  start(): Promise<ProviderHandshake>
  dispatch(request: ProviderRequest): Promise<ProviderResponse>
  cancel(requestId: string): Promise<void>
  close(): Promise<void>
}
