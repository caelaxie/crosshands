import type { Suggestion } from '@crosshands/contract'

import { elapsedMs, type JevHttpStats } from './http.js'
import type { TreeMove } from './tree.js'

export type { JevHttpStats }

const ERROR_BODY_CAP = 512

export class JevEvaluateError extends Error {
  readonly http: JevHttpStats
  readonly errorBody?: string
  readonly errorBodyTruncated?: true
  constructor(message: string, http: JevHttpStats, body?: { text: string; truncated: boolean }) {
    super(message)
    this.name = 'JevEvaluateError'
    this.http = http
    if (body !== undefined) {
      this.errorBody = body.text
      if (body.truncated) this.errorBodyTruncated = true
    }
  }
}

function scrubErrorBody(body: string, apiKey: string): { text: string; truncated: boolean } {
  const scrubbed = body
    .split(apiKey)
    .join('[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  if (scrubbed.length <= ERROR_BODY_CAP) return { text: scrubbed, truncated: false }
  return { text: scrubbed.slice(0, ERROR_BODY_CAP), truncated: true }
}

export type JevAnswers = {
  move: 'click' | 'setValue' | 'wait' | 'done' | 'blocked'
  clickWhich?: string
  setValueWhich?: string
  confidence?: number
  goalMet?: number
  blockedReason?: string
}

export type EvaluateResult = {
  answers: JevAnswers
  http?: JevHttpStats
}

export type EvaluateInput = {
  goal: string
  app?: string
  moves: readonly TreeMove[]
}

export type EvaluateFn = (input: EvaluateInput) => Promise<EvaluateResult>

export const GATE_REFUSE_BELOW = 0.35

export function namedTargetAllowed(confidence: number | undefined): boolean {
  if (confidence === undefined) return true
  return confidence >= GATE_REFUSE_BELOW
}

export function suggestionFromAnswers(
  snapshotId: string,
  moves: readonly TreeMove[],
  answers: JevAnswers
): Suggestion {
  const byIndex = new Map(moves.map((move) => [String(move.elementIndex), move]))
  if (answers.move === 'wait') {
    return { untrusted: true, snapshotId, move: { kind: 'wait' }, confidence: answers.confidence }
  }
  if (answers.move === 'done') {
    return { untrusted: true, snapshotId, move: { kind: 'done' }, confidence: answers.confidence }
  }
  if (answers.move === 'blocked') {
    return {
      untrusted: true,
      snapshotId,
      move: { kind: 'blocked', reason: answers.blockedReason ?? 'blocked' },
      confidence: answers.confidence
    }
  }
  const raw = answers.move === 'setValue' ? answers.setValueWhich : answers.clickWhich
  const selected = raw === undefined ? undefined : byIndex.get(raw)
  if (selected === undefined) {
    return {
      untrusted: true,
      snapshotId,
      move: { kind: 'blocked', reason: 'no_candidate' },
      confidence: answers.confidence
    }
  }
  return {
    untrusted: true,
    snapshotId,
    move: { kind: answers.move, elementIndex: selected.elementIndex },
    confidence: answers.confidence,
    label: `${selected.role} ${selected.label}`.trim()
  }
}

function criteria(moves: readonly TreeMove[]): Record<string, string> {
  return Object.fromEntries(
    moves.map((move) => [String(move.elementIndex), `${move.role} ${move.label}`.trim()])
  )
}

type SystemOneAnswer = {
  type?: string
  choice?: string
  noul?: number
  confidence?: number
}

const JEV_MODEL = 'jev-latest'

function httpStats(
  started: number,
  requestBytes: number,
  status: number,
  responseBytes: number
): JevHttpStats {
  return {
    status,
    durationMs: elapsedMs(started),
    requestBytes,
    responseBytes
  }
}

function answersOf(raw: Record<string, SystemOneAnswer>): JevAnswers {
  const move = raw.move?.choice
  if (
    move !== 'click' &&
    move !== 'setValue' &&
    move !== 'wait' &&
    move !== 'done' &&
    move !== 'blocked'
  ) {
    return { move: 'blocked', blockedReason: 'no_candidate' }
  }
  const clickWhich = raw.click_which?.choice
  const setValueWhich = raw.setvalue_which?.choice
  const confidence = raw.move?.confidence ?? raw.click_which?.confidence
  const goalMet = raw.goal_met?.noul
  return {
    move,
    ...(clickWhich === undefined ? {} : { clickWhich }),
    ...(setValueWhich === undefined ? {} : { setValueWhich }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(goalMet === undefined ? {} : { goalMet })
  }
}

export function liveEvaluator(apiKey: string): EvaluateFn {
  return async (input) => {
    const clickable = criteria(input.moves)
    const payload = JSON.stringify({
      model: JEV_MODEL,
      state: {
        goal: input.goal,
        ...(input.app === undefined ? {} : { app: input.app }),
        clickable
      },
      questions: {
        move: {
          type: 'choice',
          instructions: 'What should we do next for the goal?',
          criteria: {
            click: 'Press one clickable control',
            setValue: 'Pick a field for the caller to fill',
            wait: 'The window is still loading',
            done: 'The goal is already met',
            blocked: 'Stop'
          }
        },
        click_which: {
          type: 'choice',
          instructions: 'If the move is click, which control?',
          criteria: clickable
        },
        setvalue_which: {
          type: 'choice',
          instructions: 'If the move is setValue, which field?',
          criteria: clickable
        },
        goal_met: {
          type: 'noul',
          instructions: 'Is the goal already met?'
        }
      }
    })
    const requestBytes = Buffer.byteLength(payload)
    const started = Date.now()
    let status = 0
    let responseBytes = 0
    let raw = ''
    try {
      const response = await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        body: payload
      })
      status = response.status
      raw = await response.text()
      responseBytes = Buffer.byteLength(raw)
    } catch (cause) {
      throw new JevEvaluateError(
        cause instanceof Error ? cause.message : 'TypeSafe HTTP failed',
        httpStats(started, requestBytes, 0, 0)
      )
    }
    const http = httpStats(started, requestBytes, status, responseBytes)
    if (status < 200 || status >= 300) {
      throw new JevEvaluateError(`TypeSafe HTTP ${status}`, http, scrubErrorBody(raw, apiKey))
    }
    let parsed: { answers?: Record<string, SystemOneAnswer> }
    try {
      parsed = JSON.parse(raw) as { answers?: Record<string, SystemOneAnswer> }
    } catch {
      throw new JevEvaluateError('TypeSafe HTTP response was not JSON', http)
    }
    return { answers: answersOf(parsed.answers ?? {}), http }
  }
}
