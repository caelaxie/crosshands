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
  recordRank,
  type JevCall,
  type JevDebugRecord,
  type JevLogger,
  type JevPhase,
  type JevRankStats,
  type RankRecorder
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

type RankOutcome = {
  stats: JevRankStats
  suggestion?: Suggestion
  answers?: JevAnswers
  clickable?: Record<string, string>
  errorBody?: string
  errorBodyTruncated?: true
} & ({ ok: true; suggestion: Suggestion } | { ok: false })

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

function publicErrorCode(cause: unknown): string {
  return cause instanceof ComputerError ? cause.code : 'invalid_argument'
}

function postedCriteria(moves: readonly TreeMove[]): Record<string, string> {
  const criteria: Record<string, string> = {}
  for (const move of moves) {
    criteria[String(move.elementIndex)] = `${move.role} ${move.label}`.trim().slice(0, 200)
  }
  return criteria
}

function debugAnswers(answers: JevAnswers): NonNullable<JevDebugRecord['answers']> {
  return {
    move: answers.move,
    ...(answers.clickWhich === undefined ? {} : { clickWhich: answers.clickWhich }),
    ...(answers.setValueWhich === undefined ? {} : { setValueWhich: answers.setValueWhich }),
    ...(answers.confidence === undefined ? {} : { confidence: answers.confidence }),
    ...(answers.goalMet === undefined ? {} : { goalMet: answers.goalMet })
  }
}

function noteRank(
  log: JevLogger | undefined,
  call: JevCall | undefined,
  record: RankRecorder,
  phase: JevPhase,
  goal: string,
  ranked: RankOutcome
): void {
  record(phase, ranked.stats, ranked.ok ? ranked.suggestion : undefined)
  if (log === undefined || !log.debugEnabled) return
  log.debug({
    kind: 'jev.debug',
    operation: call?.operation ?? 'computer',
    ...(call === undefined ? {} : { callId: call.callId }),
    phase,
    ...(goal.length > 0 ? { goal } : {}),
    ...(ranked.clickable === undefined ? {} : { clickable: ranked.clickable }),
    ...(ranked.answers === undefined ? {} : { answers: debugAnswers(ranked.answers) }),
    ...(ranked.stats.http === undefined ? {} : { status: ranked.stats.http.status }),
    ...(ranked.errorBody === undefined ? {} : { errorBody: ranked.errorBody }),
    ...(ranked.errorBodyTruncated === undefined
      ? {}
      : { errorBodyTruncated: ranked.errorBodyTruncated })
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
  debug: boolean,
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
  const clickable = debug ? postedCriteria(moves) : undefined
  if (moves.length === 0) {
    return {
      ok: true,
      suggestion: {
        untrusted: true,
        snapshotId,
        move: { kind: 'blocked', reason: 'no_candidate' }
      },
      stats,
      ...(clickable === undefined ? {} : { clickable })
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
    if (
      suggestion.move.kind === 'blocked' &&
      suggestion.move.reason === 'no_candidate' &&
      which !== undefined &&
      which.length > 0
    ) {
      stats.unresolvedChoice = which.slice(0, 64)
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
      ...(clickable === undefined ? {} : { clickable })
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
      ...(clickable === undefined ? {} : { clickable }),
      ...(cause instanceof JevEvaluateError && cause.errorBody !== undefined
        ? { errorBody: cause.errorBody }
        : {}),
      ...(cause instanceof JevEvaluateError && cause.errorBodyTruncated === true
        ? { errorBodyTruncated: true }
        : {})
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
  record: RankRecorder,
  log: JevLogger | undefined,
  call: JevCall | undefined
): Promise<unknown> {
  const result = await request('getAppState', toBrokerInput('getAppState', input))
  if (env.kind === 'off') return result
  const look = snapshotResultOf(result)
  if (env.kind === 'fail_closed' || evaluate === undefined) {
    return withSnapshotIssue(look, policyUnavailable())
  }
  const app = 'app' in input && typeof input.app === 'string' ? input.app : undefined
  try {
    const ranked = await rank(look, goal, evaluate, log?.debugEnabled === true, app)
    noteRank(log, call, record, 'observe', goal, ranked)
    if (!ranked.ok) return withSnapshotIssue(look, policyUnavailable())
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
  record: RankRecorder,
  log: JevLogger | undefined,
  call: JevCall | undefined
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
  const ranked = await rank(look, goal, evaluate, log?.debugEnabled === true)
  noteRank(log, call, record, 'bind', goal, ranked)
  if (!ranked.ok) return notAttempted(policyUnavailable())
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
  record: RankRecorder,
  log: JevLogger | undefined,
  call: JevCall | undefined
): Promise<unknown | undefined> {
  const named = elementIndexOf(input)
  const token = contextTokenOf(input)
  if (token === undefined || named === undefined) return undefined
  try {
    const look = await lookAgain(request, token)
    const ranked = await rank(look, goal, evaluate, log?.debugEnabled === true)
    noteRank(log, call, record, 'named', goal, ranked)
    if (!ranked.ok) {
      if (call !== undefined) call.namedIndex = named
      return notAttempted(policyUnavailable())
    }
    const picked =
      ranked.suggestion.move.kind === 'click' || ranked.suggestion.move.kind === 'setValue'
        ? ranked.suggestion.move.elementIndex
        : undefined
    if (call !== undefined) {
      call.namedIndex = named
      if (picked !== undefined) call.pickedIndex = picked
      if (picked !== named) call.refused = 'index'
      else if (!namedTargetAllowed(ranked.suggestion.confidence)) call.refused = 'confidence'
    }
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
  const log = options.log
  let parsed: ReturnType<typeof parsePublicInput>
  try {
    parsed = parsePublicInput(operation, rawInput)
  } catch (cause) {
    if (log?.debugEnabled) {
      log.debug({ kind: 'jev.debug', operation, error: publicErrorCode(cause) })
    }
    throw cause
  }
  const { goal } = splitPublicInput(parsed)
  const evaluate = evaluatorFor(envState, options.evaluate)
  const call = log === undefined ? undefined : createJevCall(operation, goal)
  const record: RankRecorder = (phase, stats, suggestion) => {
    recordRank(log, call, phase, stats, suggestion)
  }
  const request: IntentBroker['request'] = async (name, input) => {
    const raw = await broker.request(name, input)
    if (call !== undefined) {
      call.brokerCalls += 1
      if (isBrokerResultEnvelope(raw)) call.brokerRequestIds.push(raw.requestId)
    }
    return unwrapBrokerResult(raw)
  }

  async function dispatch(): Promise<unknown> {
    if (operation === 'getAppState') {
      const look = parsed as PublicOperationInput<'getAppState'>
      return suggestObserve(request, look, parsedGoal(look), envState, evaluate, record, log, call)
    }
    if (hasIntentTarget(parsed)) {
      return bindIntentTarget(
        request,
        operation,
        parsed,
        parsedGoal(parsed),
        envState,
        evaluate,
        record,
        log,
        call
      )
    }
    if (
      goal !== undefined &&
      envState.kind === 'on' &&
      evaluate !== undefined &&
      NAMED_GATE.has(operation)
    ) {
      const gated = await gateNamedTarget(request, parsed, goal, evaluate, record, log, call)
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
    if (call !== undefined && log?.calls === true) {
      emitCall(log, call, started, cause instanceof ComputerError ? { error: cause.code } : {})
    } else if (log?.debugEnabled) {
      log.debug({
        kind: 'jev.debug',
        operation,
        ...(call === undefined ? {} : { callId: call.callId }),
        error: publicErrorCode(cause)
      })
    }
    throw cause
  }
}
