import {
  createComputerError,
  parsePublicInput,
  parsePublicOutput,
  splitPublicInput,
  toBrokerInput,
  type ComputerOperationName,
  type Suggestion
} from '@crosshands/contract'

import { namedClickAllowed, suggestionFromAnswers, type JevAnswers } from './decide.js'

export type IntentBroker = {
  request(operation: ComputerOperationName, input: unknown): Promise<unknown>
}
import { liveEvaluator, type EvaluateFn } from './evaluate.js'
import { parseJevEnv, type JevEnv } from './env.js'
import type { JevLogger } from './log.js'
import { clickableMoves, parseTreeMoves } from './tree.js'

export type DispatchOptions = {
  env?: NodeJS.ProcessEnv
  evaluate?: EvaluateFn
  log?: JevLogger
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function snapshotOf(result: unknown): Record<string, unknown> | undefined {
  return asRecord(asRecord(result)?.snapshot)
}

function treeTextOf(result: unknown): string {
  const treeText = snapshotOf(result)?.treeText
  return typeof treeText === 'string' ? treeText : ''
}

function snapshotIdOf(result: unknown): string {
  const id = snapshotOf(result)?.id
  return typeof id === 'string' ? id : 'unknown'
}

function contextTokenOf(result: unknown): string | undefined {
  const token = asRecord(asRecord(result)?.context)?.token
  return typeof token === 'string' ? token : undefined
}

function policyUnavailable() {
  return createComputerError('policy_unavailable', 'Jev could not rank this snapshot').toJSON()
}

function withIssue(result: unknown, issue: ReturnType<typeof policyUnavailable>): unknown {
  const record = asRecord(result)
  if (record === undefined) return result
  const issues = Array.isArray(record.issues) ? [...record.issues, issue] : [issue]
  return { ...record, issues }
}

function withSuggestion(result: unknown, suggestion: Suggestion): unknown {
  const record = asRecord(result)
  if (record === undefined) return result
  return { ...record, suggestion }
}

function targetKind(input: unknown): string | undefined {
  return asRecord(asRecord(input)?.target)?.kind as string | undefined
}

function elementIndexOf(input: unknown): number | undefined {
  const index = asRecord(asRecord(input)?.target)?.elementIndex
  return typeof index === 'number' ? index : undefined
}

async function rank(
  result: unknown,
  goal: string,
  evaluate: EvaluateFn,
  log: JevLogger | undefined,
  app?: string
): Promise<Suggestion | undefined> {
  const moves = clickableMoves(parseTreeMoves(treeTextOf(result)))
  if (moves.length === 0) {
    return {
      untrusted: true,
      snapshotId: snapshotIdOf(result),
      move: { kind: 'blocked', reason: 'no_candidate' }
    }
  }
  const answers: JevAnswers = await evaluate({ goal, ...(app === undefined ? {} : { app }), moves })
  const suggestion = suggestionFromAnswers(snapshotIdOf(result), moves, answers)
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

export async function dispatchPublicOperation(
  broker: IntentBroker,
  operation: ComputerOperationName,
  rawInput: unknown,
  options: DispatchOptions = {}
): Promise<unknown> {
  const envState = parseJevEnv(options.env)
  const parsed = parsePublicInput(operation, rawInput)
  const { goal, brokerInput } = splitPublicInput(parsed)
  const evaluate = evaluatorFor(envState, options.evaluate)

  if (operation === 'getAppState') {
    const result = await broker.request(operation, toBrokerInput(operation, parsed))
    if (goal === undefined || envState.kind === 'off') return result
    if (envState.kind === 'fail_closed' || evaluate === undefined) {
      return withIssue(result, policyUnavailable())
    }
    try {
      const suggestion = await rank(
        result,
        goal,
        evaluate,
        options.log,
        typeof asRecord(parsed)?.app === 'string' ? (asRecord(parsed)?.app as string) : undefined
      )
      if (suggestion === undefined) return result
      return parsePublicOutput(operation, withSuggestion(result, suggestion))
    } catch {
      return withIssue(result, policyUnavailable())
    }
  }

  const intent = targetKind(parsed) === 'intent'
  if (intent) {
    if (envState.kind === 'off') {
      throw createComputerError('invalid_argument', 'intent targeting requires CROSSHANDS_JEV=1')
    }
    if (envState.kind === 'fail_closed' || evaluate === undefined || goal === undefined) {
      throw createComputerError('intent_unavailable', 'Jev is enabled but no TypeSafe key is set')
    }
    const token = asRecord(parsed)?.contextToken
    if (typeof token !== 'string') {
      throw createComputerError('invalid_argument', 'intent targeting requires a context token')
    }
    const look = await broker.request('getAppState', {
      contextToken: token,
      captureScreenshot: false
    })
    const suggestion = await rank(look, goal, evaluate, options.log)
    if (suggestion === undefined || suggestion.move.kind !== 'click') {
      return parsePublicOutput(operation, {
        outcome: { state: 'not_attempted', error: policyUnavailable() },
        suggestion
      })
    }
    const freshToken = contextTokenOf(look)
    if (freshToken === undefined) {
      throw createComputerError('interaction_context_invalid', 'Refreshed snapshot had no token')
    }
    const rest = asRecord(brokerInput) ?? {}
    const { goal: _ignored, ...withoutGoal } = rest
    const bound = {
      ...withoutGoal,
      contextToken: freshToken,
      target: { kind: 'element', elementIndex: suggestion.move.elementIndex }
    }
    const result = await broker.request(operation, toBrokerInput(operation, bound))
    return parsePublicOutput(operation, {
      ...asRecord(result),
      resolvedTarget: { kind: 'element', elementIndex: suggestion.move.elementIndex },
      suggestion
    })
  }

  if (
    goal !== undefined &&
    envState.kind === 'on' &&
    evaluate !== undefined &&
    (operation === 'click' || operation === 'setValue')
  ) {
    const named = elementIndexOf(parsed)
    const token = asRecord(parsed)?.contextToken
    if (typeof token === 'string' && named !== undefined) {
      const look = await broker.request('getAppState', {
        contextToken: token,
        captureScreenshot: false
      })
      try {
        const suggestion = await rank(look, goal, evaluate, options.log)
        const picked =
          suggestion?.move.kind === 'click' || suggestion?.move.kind === 'setValue'
            ? suggestion.move.elementIndex
            : undefined
        if (picked !== named || !namedClickAllowed(suggestion?.confidence)) {
          return parsePublicOutput(operation, {
            outcome: {
              state: 'not_attempted',
              error: createComputerError(
                'goal_mismatch',
                'Named target does not match the per-call goal'
              ).toJSON()
            },
            suggestion
          })
        }
      } catch {
        return withIssue(
          { outcome: { state: 'not_attempted', error: policyUnavailable() } },
          policyUnavailable()
        )
      }
    }
  }

  const result = await broker.request(operation, toBrokerInput(operation, parsed))
  return result
}
