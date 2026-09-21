import { randomUUID } from 'node:crypto'

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
  type EvaluateFn,
  type JevHttpStats
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

type JevPhase = 'observe' | 'bind' | 'named'

type JevCallTrace = {
  callId: string
  operation: ComputerOperationName
  goal?: string
  phase?: JevPhase
  ranks: number
  httpMs: number
  brokerCalls: number
  bound?: boolean
  error?: string
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

function elapsedMs(started: number): number {
  return Math.max(0, Date.now() - started)
}

function httpOf(cause: unknown): JevHttpStats | undefined {
  return cause instanceof JevEvaluateError ? cause.http : undefined
}

function emitJev(log: JevLogger | undefined, record: Record<string, unknown>): void {
  try {
    log?.emit(record)
  } catch {
    // Jev logs must not fail computer-use.
  }
}

function errorCodeOf(cause: unknown): string | undefined {
  if (cause instanceof ComputerError) return cause.code
  if (
    cause !== null &&
    typeof cause === 'object' &&
    'code' in cause &&
    typeof cause.code === 'string'
  ) {
    return cause.code
  }
  return undefined
}

function errorFromResult(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined
  const record = result as Record<string, unknown>
  const outcome = record.outcome
  if (outcome !== null && typeof outcome === 'object') {
    const { state, error } = outcome as { state?: string; error?: { code?: string } }
    if ((state === 'not_attempted' || state === 'failed') && typeof error?.code === 'string') {
      return error.code
    }
  }
  if (Array.isArray(record.issues)) {
    for (const issue of record.issues) {
      if (
        issue !== null &&
        typeof issue === 'object' &&
        'code' in issue &&
        issue.code === 'policy_unavailable'
      ) {
        return 'policy_unavailable'
      }
    }
  }
  return undefined
}

function emitCall(log: JevLogger | undefined, started: number, trace: JevCallTrace): void {
  emitJev(log, {
    kind: 'jev.call',
    callId: trace.callId,
    operation: trace.operation,
    durationMs: elapsedMs(started),
    httpMs: trace.httpMs,
    brokerCalls: trace.brokerCalls,
    ranks: trace.ranks,
    ...(trace.phase === undefined ? {} : { phase: trace.phase }),
    ...(trace.bound === undefined ? {} : { bound: trace.bound }),
    ...(trace.error === undefined ? {} : { error: trace.error }),
    ...(trace.goal === undefined ? {} : { goal: trace.goal })
  })
}

function emitRankLogs(
  log: JevLogger | undefined,
  trace: JevCallTrace,
  input: {
    goal: string
    phase: JevPhase
    app?: string
    snapshotId: string
    treeChars: number
    elementCount: number
    candidateCount: number
    parseMs: number
    evaluateMs?: number
    http?: JevHttpStats
    suggestion: Suggestion
  }
): void {
  const {
    goal,
    phase,
    app,
    snapshotId,
    treeChars,
    elementCount,
    candidateCount,
    parseMs,
    evaluateMs,
    http,
    suggestion
  } = input
  trace.phase = phase
  trace.ranks += 1
  if (http !== undefined) trace.httpMs += http.durationMs
  const shared = {
    callId: trace.callId,
    operation: trace.operation,
    snapshotId,
    phase,
    goal
  }
  if (http !== undefined) {
    emitJev(log, {
      kind: 'jev.http',
      ...shared,
      status: http.status,
      durationMs: http.durationMs,
      requestBytes: http.requestBytes,
      responseBytes: http.responseBytes,
      candidateCount
    })
  }
  emitJev(log, {
    kind: 'jev.decision',
    ...shared,
    snapshotId: suggestion.snapshotId,
    ...(app === undefined ? {} : { app }),
    move: suggestion.move.kind,
    ...(suggestion.move.kind === 'click' ||
    suggestion.move.kind === 'setValue' ||
    suggestion.move.kind === 'secondary' ||
    suggestion.move.kind === 'scroll'
      ? { elementIndex: suggestion.move.elementIndex }
      : {}),
    ...(suggestion.move.kind === 'blocked' ? { reason: suggestion.move.reason } : {}),
    confidence: suggestion.confidence,
    goalChars: goal.length,
    treeChars,
    elementCount,
    candidateCount,
    parseMs,
    ...(evaluateMs === undefined ? {} : { evaluateMs })
  })
}

async function rank(
  look: SnapshotResult,
  goal: string,
  evaluate: EvaluateFn,
  log: JevLogger | undefined,
  trace: JevCallTrace,
  phase: JevPhase,
  app?: string
): Promise<Suggestion> {
  const snapshotId = look.snapshot.id
  const treeChars = look.snapshot.treeText.length
  const elementCount = look.snapshot.elementCount
  const appId = look.snapshot.app.id
  const parseStarted = Date.now()
  const moves = clickableMoves(parseTreeMoves(look.snapshot.treeText))
  const parseMs = elapsedMs(parseStarted)
  const candidateCount = moves.length
  const stats = {
    goal,
    phase,
    app: appId,
    snapshotId,
    treeChars,
    elementCount,
    candidateCount,
    parseMs
  }
  if (moves.length === 0) {
    const suggestion = {
      untrusted: true as const,
      snapshotId,
      move: { kind: 'blocked' as const, reason: 'no_candidate' }
    }
    emitRankLogs(log, trace, { ...stats, suggestion })
    return suggestion
  }
  const evalStarted = Date.now()
  try {
    const answers = await evaluate({
      goal,
      ...(app === undefined ? {} : { app }),
      moves
    })
    const suggestion = suggestionFromAnswers(snapshotId, moves, answers)
    emitRankLogs(log, trace, {
      ...stats,
      evaluateMs: elapsedMs(evalStarted),
      ...(answers.http === undefined ? {} : { http: answers.http }),
      suggestion
    })
    return suggestion
  } catch (cause) {
    const http = httpOf(cause)
    emitRankLogs(log, trace, {
      ...stats,
      evaluateMs: elapsedMs(evalStarted),
      ...(http === undefined ? {} : { http }),
      suggestion: {
        untrusted: true,
        snapshotId,
        move: { kind: 'blocked', reason: 'http_error' }
      }
    })
    throw cause
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
  goal: string | undefined,
  env: JevEnv,
  evaluate: EvaluateFn | undefined,
  log: JevLogger | undefined,
  trace: JevCallTrace
): Promise<unknown> {
  const result = await request('getAppState', toBrokerInput('getAppState', input))
  if (goal === undefined || env.kind === 'off') return result
  const look = snapshotResultOf(result)
  if (env.kind === 'fail_closed' || evaluate === undefined) {
    trace.phase = 'observe'
    trace.error = 'policy_unavailable'
    return withSnapshotIssue(look, policyUnavailable())
  }
  try {
    const app = 'app' in input && typeof input.app === 'string' ? input.app : undefined
    const suggestion = await rank(look, goal, evaluate, log, trace, 'observe', app)
    return parsePublicOutput('getAppState', { ...look, suggestion })
  } catch {
    trace.error = 'policy_unavailable'
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
  log: JevLogger | undefined,
  trace: JevCallTrace
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
    suggestion = await rank(look, goal, evaluate, log, trace, 'bind')
  } catch (cause) {
    if (cause instanceof ComputerError) throw cause
    trace.bound = false
    trace.error = 'policy_unavailable'
    return notAttempted(policyUnavailable())
  }
  const index = boundIndex(operation, suggestion)
  if (index === undefined) {
    trace.bound = false
    trace.error = 'policy_unavailable'
    return notAttempted(policyUnavailable(), suggestion)
  }
  const bound = {
    ...splitPublicInput(input).rest,
    contextToken: look.context.token,
    target: { kind: 'element' as const, elementIndex: index }
  }
  const result = await request(operation, toBrokerInput(operation, bound))
  trace.bound = true
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
  log: JevLogger | undefined,
  trace: JevCallTrace
): Promise<unknown | undefined> {
  const named = elementIndexOf(input)
  const token = contextTokenOf(input)
  if (token === undefined || named === undefined) return undefined
  try {
    const look = await lookAgain(request, token)
    const suggestion = await rank(look, goal, evaluate, log, trace, 'named')
    const picked =
      suggestion.move.kind === 'click' || suggestion.move.kind === 'setValue'
        ? suggestion.move.elementIndex
        : undefined
    if (picked !== named || !namedTargetAllowed(suggestion.confidence)) {
      trace.bound = false
      trace.error = 'goal_mismatch'
      return notAttempted(
        createComputerError(
          'goal_mismatch',
          'Named target does not match the per-call goal'
        ).toJSON(),
        suggestion
      )
    }
  } catch {
    trace.bound = false
    trace.error = 'policy_unavailable'
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
  const started = Date.now()
  const trace: JevCallTrace = {
    callId: randomUUID(),
    operation,
    ...(goal === undefined ? {} : { goal }),
    ranks: 0,
    httpMs: 0,
    brokerCalls: 0
  }
  const request: IntentBroker['request'] = async (name, input) => {
    trace.brokerCalls += 1
    return unwrapBrokerResult(await broker.request(name, input))
  }

  try {
    let result: unknown
    if (operation === 'getAppState') {
      result = await suggestObserve(
        request,
        parsed as PublicOperationInput<'getAppState'>,
        goal,
        envState,
        evaluate,
        options.log,
        trace
      )
    } else if (hasIntentTarget(parsed)) {
      result = await bindIntentTarget(
        request,
        operation,
        parsed,
        goal,
        envState,
        evaluate,
        options.log,
        trace
      )
    } else if (
      goal !== undefined &&
      envState.kind === 'on' &&
      evaluate !== undefined &&
      NAMED_GATE.has(operation)
    ) {
      const gated = await gateNamedTarget(request, parsed, goal, evaluate, options.log, trace)
      if (gated !== undefined) result = gated
      else {
        if (trace.phase === 'named') trace.bound = true
        result = await request(operation, toBrokerInput(operation, parsed))
      }
    } else {
      result = await request(operation, toBrokerInput(operation, parsed))
    }
    if (trace.error === undefined) {
      const fromResult = errorFromResult(result)
      if (fromResult !== undefined) trace.error = fromResult
    }
    emitCall(options.log, started, trace)
    return result
  } catch (cause) {
    if (trace.error === undefined) {
      const code = errorCodeOf(cause)
      if (code !== undefined) trace.error = code
    }
    emitCall(options.log, started, trace)
    throw cause
  }
}
