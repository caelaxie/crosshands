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
  JevEvaluateError,
  liveEvaluator,
  namedTargetAllowed,
  suggestionFromAnswers,
  type EvaluateFn
} from './evaluate.js'
import { elapsedMs } from './http.js'
import {
  createJevCall,
  emitCall,
  recordRank,
  type JevCall,
  type JevLogger,
  type JevRankStats,
  type RankRecorder
} from './log.js'
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

type RankOutcome =
  | { ok: true; suggestion: Suggestion; stats: JevRankStats }
  | { ok: false; stats: JevRankStats }

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

function errorFromResult(result: unknown): string | undefined {
  const mutation = PublicMutationResultSchema.safeParse(result)
  if (mutation.success) {
    const outcome = mutation.data.outcome
    if (outcome.state === 'not_attempted' || outcome.state === 'failed') return outcome.error?.code
    return undefined
  }
  const snapshot = PublicSnapshotResultSchema.safeParse(result)
  if (!snapshot.success) return undefined
  return snapshot.data.issues.find((issue) => issue.code === 'policy_unavailable')?.code
}

function boundFromCall(call: JevCall | undefined, result: unknown): boolean | undefined {
  if (call?.phase !== 'bind') return undefined
  const mutation = PublicMutationResultSchema.safeParse(result)
  return mutation.success && mutation.data.resolvedTarget !== undefined
}

async function rank(
  look: SnapshotResult,
  goal: string,
  evaluate: EvaluateFn,
  app?: string
): Promise<RankOutcome> {
  const snapshotId = look.snapshot.id
  const parseStarted = Date.now()
  const moves = clickableMoves(parseTreeMoves(look.snapshot.treeText))
  const stats: JevRankStats = {
    snapshotId,
    treeChars: look.snapshot.treeText.length,
    elementCount: look.snapshot.elementCount,
    candidateCount: moves.length,
    parseMs: elapsedMs(parseStarted),
    goalChars: goal.length,
    app: look.snapshot.app.id
  }
  if (moves.length === 0) {
    return {
      ok: true,
      suggestion: {
        untrusted: true,
        snapshotId,
        move: { kind: 'blocked', reason: 'no_candidate' }
      },
      stats
    }
  }
  const evalStarted = Date.now()
  try {
    const evaluated = await evaluate({
      goal,
      ...(app === undefined ? {} : { app }),
      moves
    })
    return {
      ok: true,
      suggestion: suggestionFromAnswers(snapshotId, moves, evaluated.answers),
      stats: {
        ...stats,
        evaluateMs: elapsedMs(evalStarted),
        ...(evaluated.http === undefined ? {} : { http: evaluated.http })
      }
    }
  } catch (cause) {
    if (cause instanceof ComputerError) throw cause
    const http = cause instanceof JevEvaluateError ? cause.http : undefined
    return {
      ok: false,
      stats: {
        ...stats,
        evaluateMs: elapsedMs(evalStarted),
        ...(http === undefined ? {} : { http })
      }
    }
  }
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
  goal: string,
  env: JevEnv,
  evaluate: EvaluateFn | undefined,
  record: RankRecorder
): Promise<unknown> {
  const result = await request('getAppState', toBrokerInput('getAppState', input))
  if (env.kind === 'off') return result
  const look = snapshotResultOf(result)
  if (env.kind === 'fail_closed' || evaluate === undefined) {
    return withSnapshotIssue(look, policyUnavailable())
  }
  const app = 'app' in input && typeof input.app === 'string' ? input.app : undefined
  try {
    const ranked = await rank(look, goal, evaluate, app)
    if (!ranked.ok) {
      record('observe', ranked.stats)
      return withSnapshotIssue(look, policyUnavailable())
    }
    record('observe', ranked.stats, ranked.suggestion)
    return parsePublicOutput('getAppState', { ...look, suggestion: ranked.suggestion })
  } catch {
    return withSnapshotIssue(look, policyUnavailable())
  }
}

async function bindIntentTarget(
  request: IntentBroker['request'],
  operation: ComputerOperationName,
  input: object,
  goal: string,
  env: JevEnv,
  evaluate: EvaluateFn | undefined,
  record: RankRecorder
): Promise<unknown> {
  if (env.kind === 'off') {
    throw createComputerError('invalid_argument', 'intent targeting requires CROSSHANDS_JEV=1')
  }
  if (env.kind === 'fail_closed' || evaluate === undefined) {
    throw createComputerError('intent_unavailable', 'Jev is enabled but no TypeSafe key is set')
  }
  const token = contextTokenOf(input)
  if (token === undefined) {
    throw createComputerError('invalid_argument', 'intent targeting requires a context token')
  }
  let look: SnapshotResult
  try {
    look = await lookAgain(request, token)
  } catch (cause) {
    if (cause instanceof ComputerError) throw cause
    return notAttempted(policyUnavailable())
  }
  const ranked = await rank(look, goal, evaluate)
  if (!ranked.ok) {
    record('bind', ranked.stats)
    return notAttempted(policyUnavailable())
  }
  record('bind', ranked.stats, ranked.suggestion)
  const index = boundIndex(operation, ranked.suggestion)
  if (index === undefined) return notAttempted(policyUnavailable(), ranked.suggestion)
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
    suggestion: ranked.suggestion
  })
}

async function gateNamedTarget(
  request: IntentBroker['request'],
  input: object,
  goal: string,
  evaluate: EvaluateFn,
  record: RankRecorder
): Promise<unknown | undefined> {
  const named = elementIndexOf(input)
  const token = contextTokenOf(input)
  if (token === undefined || named === undefined) return undefined
  try {
    const look = await lookAgain(request, token)
    const ranked = await rank(look, goal, evaluate)
    if (!ranked.ok) {
      record('named', ranked.stats)
      return notAttempted(policyUnavailable())
    }
    record('named', ranked.stats, ranked.suggestion)
    const picked =
      ranked.suggestion.move.kind === 'click' || ranked.suggestion.move.kind === 'setValue'
        ? ranked.suggestion.move.elementIndex
        : undefined
    if (picked !== named || !namedTargetAllowed(ranked.suggestion.confidence)) {
      return notAttempted(
        createComputerError(
          'goal_mismatch',
          'Named target does not match the per-call goal'
        ).toJSON(),
        ranked.suggestion
      )
    }
  } catch {
    return notAttempted(policyUnavailable())
  }
  return undefined
}

function parsedGoal(input: object): string {
  const { goal } = splitPublicInput(input)
  if (goal === undefined) throw createComputerError('invalid_argument', 'Missing required goal')
  return goal
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
  const log = options.log
  const call = log === undefined ? undefined : createJevCall(operation, goal)
  const record: RankRecorder = (phase, stats, suggestion) => {
    recordRank(log, call, phase, stats, suggestion)
  }
  const request: IntentBroker['request'] = async (name, input) => {
    if (call !== undefined) call.brokerCalls += 1
    return unwrapBrokerResult(await broker.request(name, input))
  }

  async function dispatch(): Promise<unknown> {
    if (operation === 'getAppState') {
      const look = parsed as PublicOperationInput<'getAppState'>
      return suggestObserve(request, look, parsedGoal(look), envState, evaluate, record)
    }
    if (hasIntentTarget(parsed)) {
      return bindIntentTarget(
        request,
        operation,
        parsed,
        parsedGoal(parsed),
        envState,
        evaluate,
        record
      )
    }
    if (
      goal !== undefined &&
      envState.kind === 'on' &&
      evaluate !== undefined &&
      NAMED_GATE.has(operation)
    ) {
      const gated = await gateNamedTarget(request, parsed, goal, evaluate, record)
      if (gated !== undefined) return gated
    }
    return request(operation, toBrokerInput(operation, parsed))
  }

  const started = Date.now()
  try {
    const result = await dispatch()
    if (call !== undefined) {
      const extra: { error?: string; bound?: boolean } = {}
      const error = errorFromResult(result)
      const bound = boundFromCall(call, result)
      if (error !== undefined) extra.error = error
      if (bound !== undefined) extra.bound = bound
      emitCall(log, call, started, extra)
    }
    return result
  } catch (cause) {
    if (call !== undefined) {
      emitCall(log, call, started, cause instanceof ComputerError ? { error: cause.code } : {})
    }
    throw cause
  }
}
