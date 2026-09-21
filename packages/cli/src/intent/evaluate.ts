import type { Suggestion } from '@crosshands/contract'

import type { TreeMove } from './tree.js'

export type JevAnswers = {
  move: 'click' | 'setValue' | 'wait' | 'done' | 'blocked'
  clickWhich?: string
  setValueWhich?: string
  confidence?: number
  goalMet?: number
  blockedReason?: string
}

export type EvaluateInput = {
  goal: string
  app?: string
  moves: readonly TreeMove[]
}

export type EvaluateFn = (input: EvaluateInput) => Promise<JevAnswers>

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

export function liveEvaluator(apiKey: string): EvaluateFn {
  return async (input) => {
    const clickable = criteria(input.moves)
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'jev-latest',
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
    })
    if (!response.ok) {
      throw new Error(`TypeSafe HTTP ${response.status}`)
    }
    const body = (await response.json()) as {
      answers?: Record<string, SystemOneAnswer>
    }
    const answers = body.answers ?? {}
    const move = answers.move?.choice
    if (
      move !== 'click' &&
      move !== 'setValue' &&
      move !== 'wait' &&
      move !== 'done' &&
      move !== 'blocked'
    ) {
      return { move: 'blocked', blockedReason: 'no_candidate' }
    }
    const clickWhich = answers.click_which?.choice
    const setValueWhich = answers.setvalue_which?.choice
    const confidence = answers.move?.confidence ?? answers.click_which?.confidence
    const goalMet = answers.goal_met?.noul
    return {
      move,
      ...(clickWhich === undefined ? {} : { clickWhich }),
      ...(setValueWhich === undefined ? {} : { setValueWhich }),
      ...(confidence === undefined ? {} : { confidence }),
      ...(goalMet === undefined ? {} : { goalMet })
    }
  }
}
