import { z } from 'zod'

import { SerializedComputerErrorSchema } from './errors.js'

const FiniteNumberSchema = z.number().finite()
const NonNegativeIntegerSchema = z.number().int().nonnegative()
const PositiveIntegerSchema = z.number().int().positive()
const IdentifierSchema = z.string().min(1).max(512)
export const InteractionContextTokenSchema = z.string().regex(/^ctx_[A-Za-z0-9_-]{32,}$/)

export const ProcessIdentitySchema = z
  .object({
    pid: PositiveIntegerSchema,
    startedAt: z.iso.datetime(),
    executableId: IdentifierSchema
  })
  .strict()

export const WindowIdentitySchema = z
  .object({
    id: IdentifierSchema,
    ownerPid: PositiveIntegerSchema
  })
  .strict()

export const ReferenceBindingsSchema = z
  .object({
    brokerGeneration: IdentifierSchema,
    providerGeneration: IdentifierSchema,
    graphicalSessionId: IdentifierSchema,
    process: ProcessIdentitySchema,
    appId: IdentifierSchema,
    window: WindowIdentitySchema,
    snapshotId: IdentifierSchema,
    desktopEpoch: NonNegativeIntegerSchema
  })
  .strict()

export type ReferenceBindings = z.infer<typeof ReferenceBindingsSchema>

export const InteractionContextSchema = ReferenceBindingsSchema.extend({
  token: InteractionContextTokenSchema,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime()
}).strict()

export type InteractionContext = z.infer<typeof InteractionContextSchema>

export const TargetReferenceSchema = ReferenceBindingsSchema.extend({
  ref: IdentifierSchema,
  kind: z.enum(['app', 'window', 'element']),
  contextToken: InteractionContextTokenSchema,
  expiresAt: z.iso.datetime()
}).strict()

export type TargetReference = z.infer<typeof TargetReferenceSchema>

export const AppInfoSchema = z
  .object({
    id: IdentifierSchema,
    name: z.string().min(1),
    bundleId: z.string().min(1).nullable(),
    pid: PositiveIntegerSchema,
    isRunning: z.boolean()
  })
  .strict()

export const WindowInfoSchema = z
  .object({
    id: IdentifierSchema,
    appId: IdentifierSchema,
    title: z.string(),
    index: NonNegativeIntegerSchema,
    bounds: z
      .object({
        x: FiniteNumberSchema,
        y: FiniteNumberSchema,
        width: z.number().finite().positive(),
        height: z.number().finite().positive()
      })
      .strict(),
    minimized: z.boolean()
  })
  .strict()

export const ScreenshotSchema = z
  .object({
    format: z.literal('png'),
    width: PositiveIntegerSchema,
    height: PositiveIntegerSchema,
    scale: z.number().finite().positive(),
    data: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    expiresAt: z.iso.datetime().optional()
  })
  .strict()
  .refine((value) => value.data !== undefined || value.path !== undefined, {
    message: 'Screenshot must include data or path'
  })

export const SnapshotSchema = z
  .object({
    id: IdentifierSchema,
    app: AppInfoSchema,
    window: WindowInfoSchema,
    treeText: z.string(),
    elementCount: NonNegativeIntegerSchema,
    focusedElementRef: z.string().nullable(),
    desktopEpoch: NonNegativeIntegerSchema
  })
  .strict()

export const MutationOutcomeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('verified'), evidence: z.unknown().optional() }).strict(),
  z.object({ state: z.literal('indeterminate'), reason: z.string().optional() }).strict(),
  z
    .object({ state: z.literal('failed'), error: SerializedComputerErrorSchema.optional() })
    .strict(),
  z
    .object({ state: z.literal('not_attempted'), error: SerializedComputerErrorSchema.optional() })
    .strict()
])

export type MutationOutcome = z.infer<typeof MutationOutcomeSchema>

export const SnapshotResultSchema = z
  .object({
    context: InteractionContextSchema,
    snapshot: SnapshotSchema,
    screenshot: ScreenshotSchema.nullable(),
    issues: z.array(SerializedComputerErrorSchema).default([])
  })
  .strict()

export type SnapshotResult = z.infer<typeof SnapshotResultSchema>

export const MutationResultSchema = z
  .object({
    outcome: MutationOutcomeSchema,
    freshState: SnapshotResultSchema.optional()
  })
  .strict()

export type MutationResult = z.infer<typeof MutationResultSchema>

const BooleanFlagMapSchema = z.record(z.string(), z.boolean())

export const ProviderSupportsSchema = z
  .object({
    apps: BooleanFlagMapSchema.optional(),
    windows: BooleanFlagMapSchema.optional(),
    surfaces: BooleanFlagMapSchema.optional(),
    observation: BooleanFlagMapSchema.optional(),
    actions: BooleanFlagMapSchema.optional()
  })
  .strict()

export const ProviderHelperIdentitySchema = z
  .object({
    name: z.string().min(1),
    bundleId: z.string().min(1)
  })
  .strict()

export const ProviderCapabilitiesSchema = z
  .object({
    platform: z.enum(['darwin', 'win32', 'linux']),
    provider: IdentifierSchema,
    providerVersion: z.string().min(1),
    operations: z.record(z.string(), z.boolean()),
    permissions: z.record(z.string(), z.enum(['granted', 'denied', 'unknown', 'not_required'])),
    supports: ProviderSupportsSchema.optional()
  })
  .strict()

export const ProviderHandshakeSchema = z
  .object({
    provider: IdentifierSchema,
    generation: IdentifierSchema,
    graphicalSessionId: IdentifierSchema,
    providerProtocol: PositiveIntegerSchema,
    publicContract: z.string().min(1),
    capabilities: ProviderCapabilitiesSchema,
    helper: ProviderHelperIdentitySchema.optional()
  })
  .strict()
