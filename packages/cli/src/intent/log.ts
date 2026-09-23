import { createHash, randomUUID } from 'node:crypto'

import type { Suggestion } from '@crosshands/contract'
import { JsonlFileWriter, diagnosticsDirectory } from '@crosshands/runtime'

import { localClientPaths } from '../local-client.js'
import { jevDebugEnabled, parseJevEnv } from './env.js'
import { elapsedMs, type JevHttpStats } from './http.js'

export type JevPhase = 'observe' | 'bind' | 'named'

type JevShared = {
  callId: string
  operation: string
  snapshotId: string
  phase: JevPhase
  goal?: string
}

export type JevCallRecord = {
  kind: 'jev.call'
  callId: string
  operation: string
  durationMs: number
  httpMs: number
  brokerCalls: number
  ranks: number
  phase?: JevPhase
  bound?: boolean
  error?: string
  goal?: string
  brokerRequestIds?: string[]
  namedIndex?: number
  pickedIndex?: number
  refused?: 'index' | 'confidence'
}

export type JevHttpRecord = JevShared & {
  kind: 'jev.http'
  status: number
  durationMs: number
  requestBytes: number
  responseBytes: number
  candidateCount: number
}

export type JevDecisionRecord = JevShared & {
  kind: 'jev.decision'
  app?: string
  move: Suggestion['move']['kind']
  elementIndex?: number
  reason?: string
  confidence?: number
  goalChars: number
  treeChars: number
  elementCount: number
  candidateCount: number
  parseMs: number
  evaluateMs?: number
  goalMet?: number
  candidateTotal?: number
  capped?: true
  unresolvedChoice?: string
}

export type JevDebugAnswers = {
  move: string
  clickWhich?: string
  setValueWhich?: string
  confidence?: number
  goalMet?: number
}

export type JevDebugRecord = {
  kind: 'jev.debug'
  operation: string
  callId?: string
  phase?: JevPhase
  goal?: string
  clickable?: Record<string, string>
  answers?: JevDebugAnswers
  status?: number
  errorBody?: string
  errorBodyTruncated?: true
  error?: string
}

export type JevRecord = JevCallRecord | JevHttpRecord | JevDecisionRecord

export type JevLogger = {
  readonly calls: boolean
  readonly debugEnabled: boolean
  emit(record: JevRecord): void
  debug(record: JevDebugRecord): void
  close(): Promise<void>
}

export type JevCall = {
  callId: string
  operation: string
  goal?: string
  ranks: number
  httpMs: number
  brokerCalls: number
  phase?: JevPhase
  brokerRequestIds: string[]
  namedIndex?: number
  pickedIndex?: number
  refused?: 'index' | 'confidence'
}

export type JevRankStats = {
  snapshotId: string
  treeChars: number
  elementCount: number
  candidateCount: number
  parseMs: number
  goalChars: number
  evaluateMs?: number
  app?: string
  http?: JevHttpStats
  goalMet?: number
  candidateTotal?: number
  capped?: true
  unresolvedChoice?: string
}

export type RankRecorder = (phase: JevPhase, stats: JevRankStats, suggestion?: Suggestion) => void

export function hashGoal(goal: string): string {
  return createHash('sha256').update(goal).digest('hex')
}

const OMIT = new Set(['goal', 'apiKey', 'treeText', 'text', 'value', 'TYPESAFE_API_KEY'])

export function createJevCall(operation: string, goal?: string): JevCall {
  return {
    callId: randomUUID(),
    operation,
    ...(goal === undefined ? {} : { goal }),
    ranks: 0,
    httpMs: 0,
    brokerCalls: 0,
    brokerRequestIds: []
  }
}

export function recordRank(
  log: JevLogger | undefined,
  call: JevCall | undefined,
  phase: JevPhase,
  stats: JevRankStats,
  suggestion?: Suggestion
): void {
  if (call !== undefined) {
    call.phase = phase
    call.ranks += 1
    if (stats.http !== undefined) call.httpMs += stats.http.durationMs
  }
  if (log === undefined || call === undefined) return
  const shared: JevShared = {
    callId: call.callId,
    operation: call.operation,
    snapshotId: stats.snapshotId,
    phase,
    ...(call.goal === undefined ? {} : { goal: call.goal })
  }
  if (stats.http !== undefined) {
    log.emit({
      kind: 'jev.http',
      ...shared,
      status: stats.http.status,
      durationMs: stats.http.durationMs,
      requestBytes: stats.http.requestBytes,
      responseBytes: stats.http.responseBytes,
      candidateCount: stats.candidateCount
    })
  }
  if (suggestion === undefined) return
  const move = suggestion.move
  log.emit({
    kind: 'jev.decision',
    ...shared,
    ...(stats.app === undefined ? {} : { app: stats.app }),
    move: move.kind,
    ...(move.kind === 'click' ||
    move.kind === 'setValue' ||
    move.kind === 'secondary' ||
    move.kind === 'scroll'
      ? { elementIndex: move.elementIndex }
      : {}),
    ...(move.kind === 'blocked' ? { reason: move.reason } : {}),
    ...(suggestion.confidence === undefined ? {} : { confidence: suggestion.confidence }),
    goalChars: stats.goalChars,
    treeChars: stats.treeChars,
    elementCount: stats.elementCount,
    candidateCount: stats.candidateCount,
    parseMs: stats.parseMs,
    ...(stats.evaluateMs === undefined ? {} : { evaluateMs: stats.evaluateMs }),
    ...(stats.goalMet === undefined ? {} : { goalMet: stats.goalMet }),
    ...(stats.candidateTotal === undefined ? {} : { candidateTotal: stats.candidateTotal }),
    ...(stats.capped === undefined ? {} : { capped: stats.capped }),
    ...(stats.unresolvedChoice === undefined ? {} : { unresolvedChoice: stats.unresolvedChoice })
  })
}

export function emitCall(
  log: JevLogger | undefined,
  call: JevCall | undefined,
  started: number,
  extra: { error?: string; bound?: boolean } = {}
): void {
  if (log === undefined || call === undefined) return
  log.emit({
    kind: 'jev.call',
    callId: call.callId,
    operation: call.operation,
    durationMs: elapsedMs(started),
    httpMs: call.httpMs,
    brokerCalls: call.brokerCalls,
    ranks: call.ranks,
    ...(call.phase === undefined ? {} : { phase: call.phase }),
    ...(extra.bound === undefined ? {} : { bound: extra.bound }),
    ...(extra.error === undefined ? {} : { error: extra.error }),
    ...(call.goal === undefined ? {} : { goal: call.goal }),
    ...(call.brokerRequestIds.length > 0 ? { brokerRequestIds: call.brokerRequestIds } : {}),
    ...(call.namedIndex === undefined ? {} : { namedIndex: call.namedIndex }),
    ...(call.pickedIndex === undefined ? {} : { pickedIndex: call.pickedIndex }),
    ...(call.refused === undefined ? {} : { refused: call.refused })
  })
}

function writeJevLine(
  writer: JsonlFileWriter,
  record: Record<string, unknown>,
  keepGoal: boolean
): void {
  try {
    const goal = record.goal
    const rest: Record<string, unknown> = { ...record, v: 1, ts: new Date().toISOString() }
    for (const key of OMIT) {
      if (keepGoal && key === 'goal') continue
      delete rest[key]
    }
    writer.emit({
      ...rest,
      ...(typeof goal === 'string' ? { goalSha256: hashGoal(goal) } : {})
    })
  } catch {
    // Jev logs must not fail computer-use.
  }
}

export function createJevLogger(
  graphicalSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { calls?: boolean; debug?: boolean } = {}
): JevLogger {
  const calls = options.calls !== false
  const debugEnabled = options.debug === true
  const writer = new JsonlFileWriter({
    directory: diagnosticsDirectory(graphicalSessionId, { env }),
    generation: `jev-${randomUUID()}`
  })
  writer.start()
  return {
    calls,
    debugEnabled,
    emit(record) {
      if (!calls) return
      writeJevLine(writer, record, false)
    },
    debug(record) {
      if (!debugEnabled) return
      writeJevLine(writer, record, true)
    },
    close: () => writer.close()
  }
}

export function createCliJevLogger(env: NodeJS.ProcessEnv = process.env): JevLogger | undefined {
  const debug = jevDebugEnabled(env)
  if (parseJevEnv(env).kind === 'off' && !debug) return undefined
  return createJevLogger(localClientPaths().identity.graphicalSessionId, env, {
    calls: parseJevEnv(env).kind !== 'off',
    debug
  })
}
