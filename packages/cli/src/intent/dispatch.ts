import {
  ComputerError,
  createComputerError,
  hasIntentTarget,
  parsePublicInput,
  parsePublicOutput,
  PublicMutationResultSchema,
  PublicSnapshotResultSchema,
  SnapshotResultSchema,
  splitPublicInput,
  toBrokerInput,
  type ComputerOperationName,
  type PublicOperationInput,
  type SnapshotResult,
  type Suggestion
} from '@crosshands/contract'

import { unwrapBrokerResult } from '../broker-result.js'
import { parseJevEnv, type JevEnv } from './env.js'
import {
  liveEvaluator,
  namedTargetAllowed,
  suggestionFromAnswers,
  type EvaluateFn
} from './evaluate.js'
import type { JevLogger } from './log.js'
import { clickableMoves, parseTreeMoves } from './tree.js'

export type IntentBroker = {
  request(operation: ComputerOperationName, input: unknown): Promise<unknown>
}

export type DispatchOptions = {
  env?: NodeJS.ProcessEnv
  evaluate?: EvaluateFn
  log?: JevLogger
}

const NAMED_GATE = new Set<ComputerOperationName>(['click', 'setValue'])

function policyUnavailable() {
  return createComputerError('policy_unavailable', 'Jev could not rank this snapshot').toJSON()
}

function snapshotResultOf(value: unknown): SnapshotResult {
  return SnapshotResultSchema.parse(value)
}

function notAttempted(
  error: ReturnType<typeof policyUnavailable>,
  suggestion?: Suggestion
): unknown {
  return PublicMutationResultSchema.parse({
    outcome: { state: 'not_attempted', error },
    ...(suggestion === undefined ? {} : { suggestion })
  })
}

function withSnapshotIssue(
  look: SnapshotResult,
  issue: ReturnType<typeof policyUnavailable>
): unknown {
  return PublicSnapshotResultSchema.parse({
    ...look,
    issues: [...look.issues, issue]
  })
}

function contextTokenOf(input: object): string | undefined {
  if (!('contextToken' in input) || typeof input.contextToken !== 'string') return undefined
  return input.contextToken
}

function elementIndexOf(input: object): number | undefined {
  if (!('target' in input)) return undefined
  const target = input.target
  if (target === null || typeof target !== 'object' || !('elementIndex' in target)) return undefined
  return typeof target.elementIndex === 'number' ? target.elementIndex : undefined
}

function boundIndex(operation: ComputerOperationName, suggestion: Suggestion): number | undefined {
  const move = suggestion.move
  if (operation === 'setValue' && move.kind === 'setValue') return move.elementIndex
  if (
    (operation === 'click' || operation === 'scroll' || operation === 'performSecondaryAction') &&
    move.kind === 'click'
  ) {
    return move.elementIndex
  }
  return undefined
}

async function rank(
  look: SnapshotResult,
  goal: string,
  evaluate: EvaluateFn,
  log: JevLogger | undefined,
  app?: string
): Promise<Suggestion> {
  const moves = clickableMoves(parseTreeMoves(look.snapshot.treeText))
  if (moves.length === 0) {
    return {
      untrusted: true,
      snapshotId: look.snapshot.id,
      move: { kind: 'blocked', reason: 'no_candidate' }
    }
  }
  const suggestion = suggestionFromAnswers(
    look.snapshot.id,
    moves,
    await evaluate({ goal, ...(app === undefined ? {} : { app }), moves })
  )
  log?.emit({
    kind: 'jev.decision',
    snapshotId: suggestion.snapshotId,
    move: suggestion.move.kind,
    ...(suggestion.move.kind === 'click' ||
    suggestion.move.kind === 'setValue' ||
    suggestion.move.kind === 'secondary' ||
    suggestion.move.kind === 'scroll'
      ? { elementIndex: suggestion.move.elementIndex }
      : {}),
    confidence: suggestion.confidence,
    goal
  })
  return suggestion
}

function evaluatorFor(env: JevEnv, override: EvaluateFn | undefined): EvaluateFn | undefined {
  if (override !== undefined) return override
  if (env.kind !== 'on') return undefined
  return liveEvaluator(env.apiKey)
}

async function lookAgain(request: IntentBroker['request'], token: string): Promise<SnapshotResult> {
  return snapshotResultOf(
    await request('getAppState', { contextToken: token, captureScreenshot: false })
  )
}

async function suggestObserve(
  request: IntentBroker['request'],
  input: PublicOperationInput<'getAppState'>,
  goal: string | undefined,
  env: JevEnv,
  evaluate: EvaluateFn | undefined,
  log: JevLogger | undefined
): Promise<unknown> {
  const result = await request('getAppState', toBrokerInput('getAppState', input))
  if (goal === undefined || env.kind === 'off') return result
  const look = snapshotResultOf(result)
  if (env.kind === 'fail_closed' || evaluate === undefined) {
    return withSnapshotIssue(look, policyUnavailable())
  }
  try {
    const app = 'app' in input && typeof input.app === 'string' ? input.app : undefined
    const suggestion = await rank(look, goal, evaluate, log, app)
    return parsePublicOutput('getAppState', { ...look, suggestion })
  } catch {
    return withSnapshotIssue(look, policyUnavailable())
  }
}

async function bindIntentTarget(
  request: IntentBroker['request'],
  operation: ComputerOperationName,
  input: object,
  goal: string | undefined,
  env: JevEnv,
  evaluate: EvaluateFn | undefined,
  log: JevLogger | undefined
): Promise<unknown> {
  if (env.kind === 'off') {
    throw createComputerError('invalid_argument', 'intent targeting requires CROSSHANDS_JEV=1')
  }
  if (env.kind === 'fail_closed' || evaluate === undefined || goal === undefined) {
    throw createComputerError('intent_unavailable', 'Jev is enabled but no TypeSafe key is set')
  }
  const token = contextTokenOf(input)
  if (token === undefined) {
    throw createComputerError('invalid_argument', 'intent targeting requires a context token')
  }
  let look: SnapshotResult
  let suggestion: Suggestion
  try {
    look = await lookAgain(request, token)
    suggestion = await rank(look, goal, evaluate, log)
  } catch (cause) {
    if (cause instanceof ComputerError) throw cause
    return notAttempted(policyUnavailable())
  }
  const index = boundIndex(operation, suggestion)
  if (index === undefined) return notAttempted(policyUnavailable(), suggestion)
  const bound = {
    ...splitPublicInput(input).rest,
    contextToken: look.context.token,
    target: { kind: 'element' as const, elementIndex: index }
  }
  const result = await request(operation, toBrokerInput(operation, bound))
  const body = result !== null && typeof result === 'object' ? result : {}
  return parsePublicOutput(operation, {
    ...body,
    resolvedTarget: { kind: 'element', elementIndex: index },
    suggestion
  })
}

async function gateNamedTarget(
  request: IntentBroker['request'],
  input: object,
  goal: string,
  evaluate: EvaluateFn,
  log: JevLogger | undefined
): Promise<unknown | undefined> {
  const named = elementIndexOf(input)
  const token = contextTokenOf(input)
  if (token === undefined || named === undefined) return undefined
  try {
    const look = await lookAgain(request, token)
    const suggestion = await rank(look, goal, evaluate, log)
    const picked =
      suggestion.move.kind === 'click' || suggestion.move.kind === 'setValue'
        ? suggestion.move.elementIndex
        : undefined
    if (picked !== named || !namedTargetAllowed(suggestion.confidence)) {
      return notAttempted(
        createComputerError(
          'goal_mismatch',
          'Named target does not match the per-call goal'
        ).toJSON(),
        suggestion
      )
    }
  } catch {
    return notAttempted(policyUnavailable())
  }
  return undefined
}

export async function dispatchPublicOperation(
  broker: IntentBroker,
  operation: ComputerOperationName,
  rawInput: unknown,
  options: DispatchOptions = {}
): Promise<unknown> {
  const envState = parseJevEnv(options.env)
  const parsed = parsePublicInput(operation, rawInput)
  const { goal } = splitPublicInput(parsed)
  const evaluate = evaluatorFor(envState, options.evaluate)
  const request: IntentBroker['request'] = async (name, input) =>
    unwrapBrokerResult(await broker.request(name, input))

  if (operation === 'getAppState') {
    return suggestObserve(
      request,
      parsed as PublicOperationInput<'getAppState'>,
      goal,
      envState,
      evaluate,
      options.log
    )
  }
  if (hasIntentTarget(parsed)) {
    return bindIntentTarget(request, operation, parsed, goal, envState, evaluate, options.log)
  }
  if (
    goal !== undefined &&
    envState.kind === 'on' &&
    evaluate !== undefined &&
    NAMED_GATE.has(operation)
  ) {
    const gated = await gateNamedTarget(request, parsed, goal, evaluate, options.log)
    if (gated !== undefined) return gated
  }
  return request(operation, toBrokerInput(operation, parsed))
}
