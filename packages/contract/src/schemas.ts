import { z } from 'zod'

import { PublicSerializedComputerErrorSchema, SerializedComputerErrorSchema } from './errors.js'

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

function mutationOutcomeSchema<T extends z.ZodType>(errorSchema: T) {
  return z.discriminatedUnion('state', [
    z.object({ state: z.literal('verified'), evidence: z.unknown().optional() }).strict(),
    z.object({ state: z.literal('indeterminate'), reason: z.string().optional() }).strict(),
    z.object({ state: z.literal('failed'), error: errorSchema.optional() }).strict(),
    z.object({ state: z.literal('not_attempted'), error: errorSchema.optional() }).strict()
  ])
}

export const MutationOutcomeSchema = mutationOutcomeSchema(SerializedComputerErrorSchema)
export const PublicMutationOutcomeSchema = mutationOutcomeSchema(
  PublicSerializedComputerErrorSchema
)

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

export const GoalSchema = z.string().trim().min(1).max(512)

export const IntentTargetSchema = z.object({ kind: z.literal('intent') }).strict()

export const SuggestionMoveSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), elementIndex: NonNegativeIntegerSchema }).strict(),
  z.object({ kind: z.literal('setValue'), elementIndex: NonNegativeIntegerSchema }).strict(),
  z
    .object({
      kind: z.literal('secondary'),
      elementIndex: NonNegativeIntegerSchema,
      action: z.string().min(1).max(256)
    })
    .strict(),
  z
    .object({
      kind: z.literal('scroll'),
      elementIndex: NonNegativeIntegerSchema,
      direction: z.enum(['up', 'down', 'left', 'right'])
    })
    .strict(),
  z.object({ kind: z.literal('wait') }).strict(),
  z.object({ kind: z.literal('done') }).strict(),
  z.object({ kind: z.literal('blocked'), reason: z.string().min(1).max(256) }).strict()
])

export const SuggestionSchema = z
  .object({
    untrusted: z.literal(true),
    snapshotId: IdentifierSchema,
    move: SuggestionMoveSchema,
    confidence: z.number().min(0).max(1).optional(),
    label: z.string().optional()
  })
  .strict()

export type Suggestion = z.infer<typeof SuggestionSchema>

export const ResolvedTargetSchema = z
  .object({
    kind: z.literal('element'),
    elementIndex: NonNegativeIntegerSchema
  })
  .strict()

export const PublicSnapshotResultSchema = SnapshotResultSchema.omit({ issues: true })
  .extend({
    issues: z.array(PublicSerializedComputerErrorSchema).default([]),
    suggestion: SuggestionSchema.optional()
  })
  .strict()

export const MutationResultSchema = z
  .object({
    outcome: MutationOutcomeSchema,
    freshState: SnapshotResultSchema.optional()
  })
  .strict()

export type MutationResult = z.infer<typeof MutationResultSchema>

export const PublicMutationResultSchema = z
  .object({
    outcome: PublicMutationOutcomeSchema,
    freshState: SnapshotResultSchema.optional(),
    resolvedTarget: ResolvedTargetSchema.optional(),
    suggestion: SuggestionSchema.optional()
  })
  .strict()

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

export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>

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
