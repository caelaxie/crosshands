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
export type BrokerOperationInput<K extends ComputerOperationName> = z.infer<
  (typeof COMPUTER_OPERATIONS)[K]['input']
>
export type PublicOperationInput<K extends ComputerOperationName> = z.infer<
  (typeof PUBLIC_OPERATIONS)[K]['input']
>

const PublicActionTargetSchema = z.union([ActionTargetSchema, IntentTargetSchema])
const PublicElementTargetSchema = z.union([ElementActionTargetSchema, IntentTargetSchema])

function publicMutationInput(brokerInput: z.ZodObject<z.ZodRawShape>, target: z.ZodType) {
  return brokerInput
    .omit({ target: true })
    .extend({
      target,
      goal: GoalSchema.optional()
    })
    .strict()
}

function withOptionalGoal(schema: z.ZodObject<z.ZodRawShape>) {
  return schema.extend({ goal: GoalSchema.optional() }).strict()
}

const getAppStateArms = COMPUTER_OPERATIONS.getAppState.input.options

export const PUBLIC_OPERATIONS = {
  ...COMPUTER_OPERATIONS,
  getAppState: {
    mutation: false,
    input: z.union([withOptionalGoal(getAppStateArms[0]), withOptionalGoal(getAppStateArms[1])]),
    output: PublicSnapshotResultSchema
  },
  click: {
    mutation: true,
    input: publicMutationInput(COMPUTER_OPERATIONS.click.input, PublicActionTargetSchema),
    output: PublicMutationResultSchema
  },
  performSecondaryAction: {
    mutation: true,
    input: publicMutationInput(
      COMPUTER_OPERATIONS.performSecondaryAction.input,
      PublicElementTargetSchema
    ),
    output: PublicMutationResultSchema
  },
  scroll: {
    mutation: true,
    input: publicMutationInput(COMPUTER_OPERATIONS.scroll.input, PublicActionTargetSchema),
    output: PublicMutationResultSchema
  },
  setValue: {
    mutation: true,
    input: publicMutationInput(COMPUTER_OPERATIONS.setValue.input, PublicElementTargetSchema),
    output: PublicMutationResultSchema
  }
} as const

export function parseOperationInput<K extends ComputerOperationName>(
  operation: K,
  input: unknown
): BrokerOperationInput<K> {
  return COMPUTER_OPERATIONS[operation].input.parse(input) as BrokerOperationInput<K>
}

export function parseOperationOutput(operation: ComputerOperationName, output: unknown): unknown {
  return COMPUTER_OPERATIONS[operation].output.parse(output)
}

export function hasIntentTarget(input: unknown): boolean {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || !('target' in input)) {
    return false
  }
  const target = input.target
  return (
    target !== null &&
    typeof target === 'object' &&
    !Array.isArray(target) &&
    'kind' in target &&
    target.kind === 'intent'
  )
}

function requireGoalForIntent(input: unknown): void {
  if (!hasIntentTarget(input)) return
  const goal = (input as { goal?: unknown }).goal
  if (typeof goal !== 'string' || goal.length === 0) {
    throw createComputerError('invalid_argument', 'intent targeting requires goal')
  }
}

export function parsePublicInput<K extends ComputerOperationName>(
  operation: K,
  input: unknown
): PublicOperationInput<K> {
  const parsed = PUBLIC_OPERATIONS[operation].input.parse(input) as PublicOperationInput<K>
  requireGoalForIntent(parsed)
  return parsed
}

export function parsePublicOutput(operation: ComputerOperationName, output: unknown): unknown {
  return PUBLIC_OPERATIONS[operation].output.parse(output)
}

export function splitPublicInput<T extends object>(
  input: T
): { goal: string | undefined; rest: Omit<T, 'goal'> } {
  if (!('goal' in input)) return { goal: undefined, rest: input as Omit<T, 'goal'> }
  const { goal, ...rest } = input as T & { goal?: unknown }
  return {
    goal: typeof goal === 'string' && goal.length > 0 ? goal : undefined,
    rest: rest as Omit<T, 'goal'>
  }
}

export function toBrokerInput<K extends ComputerOperationName>(
  operation: K,
  publicInput: object
): BrokerOperationInput<K> {
  const { rest } = splitPublicInput(publicInput)
  if (hasIntentTarget(rest)) {
    throw createComputerError(
      'invalid_argument',
      'intent targeting must be bound before broker parse'
    )
  }
  return parseOperationInput(operation, rest)
}

export const ScreenshotOutputSchema = ScreenshotSchema
