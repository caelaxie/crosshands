import { z } from 'zod'

import {
  AppInfoSchema,
  InteractionContextTokenSchema,
  MutationResultSchema,
  ProviderCapabilitiesSchema,
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
    input: z
      .object({
        app: AppQuerySchema,
        window: WindowSelectorSchema.optional(),
        ...CaptureOptionsShape
      })
      .strict(),
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
        modifiers: z.array(z.string().min(1).max(128)).min(1).max(4).optional(),
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

export function parseOperationInput(operation: ComputerOperationName, input: unknown): unknown {
  return COMPUTER_OPERATIONS[operation].input.parse(input)
}

export function parseOperationOutput(operation: ComputerOperationName, output: unknown): unknown {
  return COMPUTER_OPERATIONS[operation].output.parse(output)
}

export const ScreenshotOutputSchema = ScreenshotSchema
