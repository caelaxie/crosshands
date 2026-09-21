import { z } from 'zod'

import { createComputerError } from './errors.js'
import {
  AppInfoSchema,
  GoalSchema,
  IntentTargetSchema,
  InteractionContextTokenSchema,
  MutationResultSchema,
  ProviderCapabilitiesSchema,
  PublicMutationResultSchema,
  PublicSnapshotResultSchema,
  ScreenshotSchema,
  SnapshotResultSchema,
  TargetReferenceSchema,
  WindowInfoSchema
} from './schemas.js'

const EmptyInputSchema = z.object({}).strict()
const AppQuerySchema = z.string().min(1).max(512)
const WindowSelectorSchema = z.union([
  z.object({ id: z.string().min(1) }).strict(),
  z.object({ index: z.number().int().nonnegative() }).strict()
])
const CaptureOptionsShape = {
  captureScreenshot: z.boolean().optional(),
  restoreWindow: z.boolean().optional()
}
const ContextWindowTargetSchema = z.object({ kind: z.literal('context-window') }).strict()
const ElementIndexTargetSchema = z
  .object({ kind: z.literal('element'), elementIndex: z.number().int().nonnegative() })
  .strict()
const CoordinateTargetSchema = z
  .object({
    kind: z.literal('coordinate'),
    window: TargetReferenceSchema.optional(),
    x: z.number().finite(),
    y: z.number().finite()
  })
  .strict()
const ElementTargetSchema = z
  .object({ kind: z.literal('element'), ref: TargetReferenceSchema })
  .strict()
const ElementActionTargetSchema = z.union([ElementTargetSchema, ElementIndexTargetSchema])
const ContextWindowMutationBaseShape = {
  contextToken: InteractionContextTokenSchema,
  app: AppQuerySchema.optional(),
  target: ContextWindowTargetSchema,
  ...CaptureOptionsShape
}
const ElementMutationBaseShape = {
  contextToken: InteractionContextTokenSchema,
  app: AppQuerySchema.optional(),
  target: ElementActionTargetSchema,
  ...CaptureOptionsShape
}
const ActionTargetSchema = z.union([
  ElementTargetSchema,
  ElementIndexTargetSchema,
  CoordinateTargetSchema,
  ContextWindowTargetSchema
])

export const CLICK_MODIFIER_TOKENS = [
  'Shift',
  'Ctrl',
  'Control',
  'Alt',
  'Option',
  'Meta',
  'Cmd',
  'Command',
  'Super',
  'Win',
  'CmdOrCtrl',
  'CommandOrControl',
  'shift',
  'ctrl',
  'control',
  'alt',
  'option',
  'meta',
  'cmd',
  'command',
  'super',
  'win',
  'cmdorctrl',
  'commandorcontrol'
] as const

const ClickModifierTokenSchema = z.enum(CLICK_MODIFIER_TOKENS)

const PermissionsResultSchema = z
  .object({
    permissions: z.record(z.string(), z.enum(['granted', 'denied', 'unknown', 'not_required']))
  })
  .strict()
const AppListResultSchema = z.object({ apps: z.array(AppInfoSchema) }).strict()
const WindowListResultSchema = z.object({ windows: z.array(WindowInfoSchema) }).strict()

export const COMPUTER_OPERATIONS = {
  capabilities: {
    mutation: false,
    input: EmptyInputSchema,
    output: ProviderCapabilitiesSchema
  },
  permissions: {
    mutation: false,
    input: z.object({ id: z.enum(['accessibility', 'screenshots']).optional() }).strict(),
    output: PermissionsResultSchema
  },
  listApps: {
    mutation: false,
    input: EmptyInputSchema,
    output: AppListResultSchema
  },
  listWindows: {
    mutation: false,
    input: z.object({ app: AppQuerySchema }).strict(),
    output: WindowListResultSchema
  },
  getAppState: {
    mutation: false,
    input: z.union([
      z
        .object({
          app: AppQuerySchema,
          window: WindowSelectorSchema.optional(),
          ...CaptureOptionsShape
        })
        .strict(),
      z
        .object({
          contextToken: InteractionContextTokenSchema,
          ...CaptureOptionsShape
        })
        .strict()
    ]),
    output: SnapshotResultSchema
  },
  click: {
    mutation: true,
    input: z
      .object({
        contextToken: InteractionContextTokenSchema,
        app: AppQuerySchema.optional(),
        target: ActionTargetSchema,
        clickCount: z.number().int().min(1).max(3).optional(),
        button: z.enum(['left', 'right', 'middle']).optional(),
        modifiers: z.array(ClickModifierTokenSchema).min(1).max(4).optional(),
        ...CaptureOptionsShape
      })
      .strict(),
    output: MutationResultSchema
  },
  performSecondaryAction: {
    mutation: true,
    input: z.object({ ...ElementMutationBaseShape, action: z.string().min(1).max(256) }).strict(),
    output: MutationResultSchema
  },
  scroll: {
    mutation: true,
    input: z
      .object({
        contextToken: InteractionContextTokenSchema,
        app: AppQuerySchema.optional(),
        target: ActionTargetSchema,
        direction: z.enum(['up', 'down', 'left', 'right']),
        pages: z.number().int().min(1).max(100).optional(),
        ...CaptureOptionsShape
      })
      .strict(),
    output: MutationResultSchema
  },
  drag: {
    mutation: true,
    input: z
      .object({
        contextToken: InteractionContextTokenSchema,
        app: AppQuerySchema.optional(),
        from: ActionTargetSchema,
        to: ActionTargetSchema,
        durationMs: z.number().int().min(50).max(30_000).optional(),
        ...CaptureOptionsShape
      })
      .strict(),
    output: MutationResultSchema
  },
  typeText: {
    mutation: true,
    input: z
      .object({ ...ContextWindowMutationBaseShape, text: z.string().max(1_000_000) })
      .strict(),
    output: MutationResultSchema
  },
  pressKey: {
    mutation: true,
    input: z
      .object({ ...ContextWindowMutationBaseShape, key: z.string().min(1).max(128) })
      .strict(),
    output: MutationResultSchema
  },
  hotkey: {
    mutation: true,
    input: z
      .object({
        ...ContextWindowMutationBaseShape,
        keys: z.array(z.string().min(1).max(128)).min(2).max(5)
      })
      .strict(),
    output: MutationResultSchema
  },
  pasteText: {
    mutation: true,
    input: z
      .object({ ...ContextWindowMutationBaseShape, text: z.string().max(1_000_000) })
      .strict(),
    output: MutationResultSchema
  },
  setValue: {
    mutation: true,
    input: z.object({ ...ElementMutationBaseShape, value: z.string().max(1_000_000) }).strict(),
    output: MutationResultSchema
  }
} as const

export type ComputerOperationName = keyof typeof COMPUTER_OPERATIONS

const PublicGetAppStateInputSchema = z.union([
  z
    .object({
      app: AppQuerySchema,
      window: WindowSelectorSchema.optional(),
      goal: GoalSchema.optional(),
      ...CaptureOptionsShape
    })
    .strict(),
  z
    .object({
      contextToken: InteractionContextTokenSchema,
      goal: GoalSchema.optional(),
      ...CaptureOptionsShape
    })
    .strict()
])

const PublicActionTargetSchema = z.union([ActionTargetSchema, IntentTargetSchema])

function withOptionalGoal<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...shape, goal: GoalSchema.optional() }).strict()
}

export const PUBLIC_OPERATIONS = {
  ...COMPUTER_OPERATIONS,
  getAppState: {
    mutation: false,
    input: PublicGetAppStateInputSchema,
    output: PublicSnapshotResultSchema
  },
  click: {
    mutation: true,
    input: withOptionalGoal({
      contextToken: InteractionContextTokenSchema,
      app: AppQuerySchema.optional(),
      target: PublicActionTargetSchema,
      clickCount: z.number().int().min(1).max(3).optional(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      modifiers: z.array(ClickModifierTokenSchema).min(1).max(4).optional(),
      ...CaptureOptionsShape
    }).superRefine((value, ctx) => {
      if (value.target.kind === 'intent' && value.goal === undefined) {
        ctx.addIssue({ code: 'custom', message: 'intent targeting requires goal', path: ['goal'] })
      }
    }),
    output: PublicMutationResultSchema
  },
  performSecondaryAction: {
    mutation: true,
    input: withOptionalGoal({
      ...ElementMutationBaseShape,
      target: z.union([ElementActionTargetSchema, IntentTargetSchema]),
      action: z.string().min(1).max(256)
    }).superRefine((value, ctx) => {
      if (value.target.kind === 'intent' && value.goal === undefined) {
        ctx.addIssue({ code: 'custom', message: 'intent targeting requires goal', path: ['goal'] })
      }
    }),
    output: PublicMutationResultSchema
  },
  scroll: {
    mutation: true,
    input: withOptionalGoal({
      contextToken: InteractionContextTokenSchema,
      app: AppQuerySchema.optional(),
      target: PublicActionTargetSchema,
      direction: z.enum(['up', 'down', 'left', 'right']),
      pages: z.number().int().min(1).max(100).optional(),
      ...CaptureOptionsShape
    }).superRefine((value, ctx) => {
      if (value.target.kind === 'intent' && value.goal === undefined) {
        ctx.addIssue({ code: 'custom', message: 'intent targeting requires goal', path: ['goal'] })
      }
    }),
    output: PublicMutationResultSchema
  },
  setValue: {
    mutation: true,
    input: withOptionalGoal({
      ...ElementMutationBaseShape,
      target: z.union([ElementActionTargetSchema, IntentTargetSchema]),
      value: z.string().max(1_000_000)
    }).superRefine((value, ctx) => {
      if (value.target.kind === 'intent' && value.goal === undefined) {
        ctx.addIssue({ code: 'custom', message: 'intent targeting requires goal', path: ['goal'] })
      }
    }),
    output: PublicMutationResultSchema
  }
} as const

export function parseOperationInput(operation: ComputerOperationName, input: unknown): unknown {
  return COMPUTER_OPERATIONS[operation].input.parse(input)
}

export function parseOperationOutput(operation: ComputerOperationName, output: unknown): unknown {
  return COMPUTER_OPERATIONS[operation].output.parse(output)
}

export function parsePublicInput(operation: ComputerOperationName, input: unknown): unknown {
  return PUBLIC_OPERATIONS[operation].input.parse(input)
}

export function parsePublicOutput(operation: ComputerOperationName, output: unknown): unknown {
  return PUBLIC_OPERATIONS[operation].output.parse(output)
}

export function splitPublicInput(input: unknown): { goal?: string; brokerInput: unknown } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { brokerInput: input }
  }
  const { goal, ...brokerInput } = input as Record<string, unknown>
  if (typeof goal === 'string' && goal.length > 0) return { goal, brokerInput }
  return { brokerInput }
}

export function toBrokerInput(operation: ComputerOperationName, publicInput: unknown): unknown {
  const { brokerInput } = splitPublicInput(publicInput)
  if (
    brokerInput !== null &&
    typeof brokerInput === 'object' &&
    'target' in brokerInput &&
    (brokerInput as { target?: { kind?: string } }).target?.kind === 'intent'
  ) {
    throw createComputerError(
      'invalid_argument',
      'intent targeting must be bound before broker parse'
    )
  }
  return parseOperationInput(operation, brokerInput)
}

export const ScreenshotOutputSchema = ScreenshotSchema
