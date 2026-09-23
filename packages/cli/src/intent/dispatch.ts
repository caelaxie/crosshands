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

import { isBrokerResultEnvelope, unwrapBrokerResult } from '../broker-result.js'
import { parseJevEnv, type JevEnv } from './env.js'
import {
  JevEvaluateError,
  criteria,
  liveEvaluator,
  namedTargetAllowed,
  suggestionFromAnswers,
  type EvaluateFn,
  type JevAnswers
} from './evaluate.js'
import { elapsedMs } from './http.js'
import {
  createJevCall,
  emitCall,
  failBeforeCall,
  failCall,
  recordRank,
  type JevCall,
  type JevLogger,
  type JevPhase,
  type JevRankStats
} from './log.js'
import { clickableMoves, parseTreeMoves, type TreeMove } from './tree.js'

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
  | {
      ok: true
      suggestion: Suggestion
      stats: JevRankStats
      answers?: JevAnswers
      moves: readonly TreeMove[]
    }
  | {
      ok: false
      stats: JevRankStats
      error?: JevEvaluateError
      moves: readonly TreeMove[]
    }

type NamedDecision = {
  named: number
  picked?: number
  refused?: 'index' | 'confidence'
}

type NamedGate =
  | { kind: 'skip' }
  | { kind: 'continue'; decision: NamedDecision }
  | { kind: 'stop'; result: unknown; decision?: NamedDecision }

type CallTrace = {
  request(operation: ComputerOperationName, input: unknown): Promise<unknown>
  note(phase: JevPhase, goal: string, ranked: RankOutcome): void
  setNamed(decision: NamedDecision): void
  finish(result: unknown): void
  fail(cause: unknown): void
}

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

function choiceIndex(which: string | undefined): number | undefined {
  if (which === undefined || !/^\d+$/.test(which)) return undefined
  const index = Number(which)
  return Number.isSafeInteger(index) ? index : undefined
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

function classifyNamed(named: number, suggestion: Suggestion): NamedDecision {
  const picked =
    suggestion.move.kind === 'click' || suggestion.move.kind === 'setValue'
      ? suggestion.move.elementIndex
      : undefined
  const refused =
    picked !== named
      ? 'index'
      : namedTargetAllowed(suggestion.confidence)
        ? undefined
        : 'confidence'
  return {
    named,
    ...(picked === undefined ? {} : { picked }),
    ...(refused === undefined ? {} : { refused })
  }
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

function openTrace(
  broker: IntentBroker,
  log: JevLogger | undefined,
  operation: string,
  goal: string | undefined,
  started: number
): CallTrace {
  const call = log === undefined ? undefined : createJevCall(operation, goal)
  return {
    async request(name, input) {
      const raw = await broker.request(name, input)
      if (call !== undefined) {
        call.brokerCalls += 1
        if (isBrokerResultEnvelope(raw)) call.brokerRequestIds.push(raw.requestId)
      }
      return unwrapBrokerResult(raw)
    },
    note(phase, goalText, ranked) {
      recordRank(log, call, phase, ranked.stats, ranked.ok ? ranked.suggestion : undefined)
      if (log === undefined || !log.debugEnabled) return
      const answers = ranked.ok ? ranked.answers : undefined
      const error = ranked.ok ? undefined : ranked.error
      log.debug({
        kind: 'jev.debug',
        operation: call?.operation ?? operation,
        ...(call === undefined ? {} : { callId: call.callId }),
        phase,
        ...(goalText.length > 0 ? { goal: goalText } : {}),
        clickable: criteria(ranked.moves),
        ...(answers === undefined ? {} : { answers }),
        ...(ranked.stats.http === undefined ? {} : { status: ranked.stats.http.status }),
        ...(error?.errorBody === undefined ? {} : { errorBody: error.errorBody }),
        ...(error?.errorBodyTruncated !== true ? {} : { errorBodyTruncated: true })
      })
    },
    setNamed(decision) {
      if (call === undefined) return
      call.namedIndex = decision.named
      if (decision.picked !== undefined) call.pickedIndex = decision.picked
      if (decision.refused !== undefined) call.refused = decision.refused
    },
    finish(result) {
      if (call === undefined) return
      const extra: { error?: string; bound?: boolean } = {}
      const error = errorFromResult(result)
      const bound = boundFromCall(call, result)
      if (error !== undefined) extra.error = error
      if (bound !== undefined) extra.bound = bound
      emitCall(log, call, started, extra)
    },
    fail(cause) {
      failCall(log, call, started, cause)
    }
  }
}

async function rank(
  look: SnapshotResult,
  goal: string,
  evaluate: EvaluateFn,
  app?: string
): Promise<RankOutcome> {
  const snapshotId = look.snapshot.id
  const parseStarted = Date.now()
  const parsedMoves = parseTreeMoves(look.snapshot.treeText)
  const candidateTotal = parsedMoves.filter((move) => move.clickable).length
  const moves = clickableMoves(parsedMoves)
  const stats: JevRankStats = {
    snapshotId,
    treeChars: look.snapshot.treeText.length,
    elementCount: look.snapshot.elementCount,
    candidateCount: moves.length,
    candidateTotal,
    parseMs: elapsedMs(parseStarted),
    goalChars: goal.length,
    app: look.snapshot.app.id,
    ...(candidateTotal > moves.length ? { capped: true } : {})
  }
  if (moves.length === 0) {
    return {
      ok: true,
      suggestion: {
        untrusted: true,
        snapshotId,
        move: { kind: 'blocked', reason: 'no_candidate' }
      },
      stats,
      moves
    }
  }
  const evalStarted = Date.now()
  try {
    const evaluated = await evaluate({
      goal,
      ...(app === undefined ? {} : { app }),
      moves
    })
    const suggestion = suggestionFromAnswers(snapshotId, moves, evaluated.answers)
    const which =
      evaluated.answers.move === 'setValue'
        ? evaluated.answers.setValueWhich
        : evaluated.answers.clickWhich
    if (suggestion.move.kind === 'blocked' && suggestion.move.reason === 'no_candidate') {
      const index = choiceIndex(which)
      if (index !== undefined) stats.unresolvedIndex = index
    }
    if (evaluated.answers.goalMet !== undefined) stats.goalMet = evaluated.answers.goalMet
    return {
      ok: true,
      suggestion,
      answers: evaluated.answers,
      stats: {
        ...stats,
        evaluateMs: elapsedMs(evalStarted),
        ...(evaluated.http === undefined ? {} : { http: evaluated.http })
      },
      moves
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
      },
      moves,
      ...(cause instanceof JevEvaluateError ? { error: cause } : {})
    }
  }
}

function evaluatorFor(env: JevEnv, override: EvaluateFn | undefined): EvaluateFn | undefined {
  if (override !== undefined) return override
  if (env.kind !== 'on') return undefined
  return liveEvaluator(env.apiKey)
}

async function lookAgain(request: CallTrace['request'], token: string): Promise<SnapshotResult> {
  return snapshotResultOf(
    await request('getAppState', { contextToken: token, captureScreenshot: false })
  )
}

async function suggestObserve(
  input: PublicOperationInput<'getAppState'>,
  goal: string,
  env: JevEnv,
  evaluate: EvaluateFn | undefined,
  trace: CallTrace
): Promise<unknown> {
  const result = await trace.request('getAppState', toBrokerInput('getAppState', input))
  if (env.kind === 'off') return result
  const look = snapshotResultOf(result)
  if (env.kind === 'fail_closed' || evaluate === undefined) {
    return withSnapshotIssue(look, policyUnavailable())
  }
  const app = 'app' in input && typeof input.app === 'string' ? input.app : undefined
  try {
    const ranked = await rank(look, goal, evaluate, app)
    trace.note('observe', goal, ranked)
    if (!ranked.ok) return withSnapshotIssue(look, policyUnavailable())
    return parsePublicOutput('getAppState', { ...look, suggestion: ranked.suggestion })
  } catch {
    return withSnapshotIssue(look, policyUnavailable())
  }
}

async function bindIntentTarget(
  operation: ComputerOperationName,
  input: object,
  goal: string,
  env: JevEnv,
  evaluate: EvaluateFn | undefined,
  trace: CallTrace
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
    look = await lookAgain(trace.request, token)
  } catch (cause) {
    if (cause instanceof ComputerError) throw cause
    return notAttempted(policyUnavailable())
  }
  const ranked = await rank(look, goal, evaluate)
  trace.note('bind', goal, ranked)
  if (!ranked.ok) return notAttempted(policyUnavailable())
  const index = boundIndex(operation, ranked.suggestion)
  if (index === undefined) return notAttempted(policyUnavailable(), ranked.suggestion)
  const bound = {
    ...splitPublicInput(input).rest,
    contextToken: look.context.token,
    target: { kind: 'element' as const, elementIndex: index }
  }
  const result = await trace.request(operation, toBrokerInput(operation, bound))
  const body = result !== null && typeof result === 'object' ? result : {}
  return parsePublicOutput(operation, {
    ...body,
    resolvedTarget: { kind: 'element', elementIndex: index },
    suggestion: ranked.suggestion
  })
}

async function gateNamedTarget(
  input: object,
  goal: string,
  evaluate: EvaluateFn,
  trace: CallTrace
): Promise<NamedGate> {
  const named = elementIndexOf(input)
  const token = contextTokenOf(input)
  if (token === undefined || named === undefined) return { kind: 'skip' }
  try {
    const look = await lookAgain(trace.request, token)
    const ranked = await rank(look, goal, evaluate)
    trace.note('named', goal, ranked)
    if (!ranked.ok) {
      return { kind: 'stop', decision: { named }, result: notAttempted(policyUnavailable()) }
    }
    const decision = classifyNamed(named, ranked.suggestion)
    if (decision.refused !== undefined) {
      return {
        kind: 'stop',
        decision,
        result: notAttempted(
          createComputerError(
            'goal_mismatch',
            'Named target does not match the per-call goal'
          ).toJSON(),
          ranked.suggestion
        )
      }
    }
    return { kind: 'continue', decision }
  } catch {
    return { kind: 'stop', result: notAttempted(policyUnavailable()) }
  }
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
  const log = options.log
  let parsed: ReturnType<typeof parsePublicInput>
  try {
    parsed = parsePublicInput(operation, rawInput)
  } catch (cause) {
    failBeforeCall(log, operation, cause)
    throw cause
  }
  const { goal } = splitPublicInput(parsed)
  const evaluate = evaluatorFor(envState, options.evaluate)
  const started = Date.now()
  const trace = openTrace(broker, log, operation, goal, started)

  async function dispatch(): Promise<unknown> {
    if (operation === 'getAppState') {
      const look = parsed as PublicOperationInput<'getAppState'>
      return suggestObserve(look, parsedGoal(look), envState, evaluate, trace)
    }
    if (hasIntentTarget(parsed)) {
      return bindIntentTarget(operation, parsed, parsedGoal(parsed), envState, evaluate, trace)
    }
    if (
      goal !== undefined &&
      envState.kind === 'on' &&
      evaluate !== undefined &&
      NAMED_GATE.has(operation)
    ) {
      const gated = await gateNamedTarget(parsed, goal, evaluate, trace)
      if (gated.kind !== 'skip' && gated.decision !== undefined) trace.setNamed(gated.decision)
      if (gated.kind === 'stop') return gated.result
    }
    return trace.request(operation, toBrokerInput(operation, parsed))
  }

  try {
    const result = await dispatch()
    trace.finish(result)
    return result
  } catch (cause) {
    trace.fail(cause)
    throw cause
  }
}
