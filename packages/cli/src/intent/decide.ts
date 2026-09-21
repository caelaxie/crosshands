import { createComputerError, type Suggestion } from '@crosshands/contract'

import type { TreeMove } from './tree.js'

export type JevAnswers = {
  move: 'click' | 'setValue' | 'wait' | 'done' | 'blocked'
  clickWhich?: string
  setValueWhich?: string
  confidence?: number
  goalMet?: number
  blockedReason?: string
}

export const GATE_REFUSE_BELOW = 0.35

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

export function assertFillableClick(suggestion: Suggestion): number {
  if (suggestion.move.kind !== 'click') {
    throw createComputerError(
      'invalid_argument',
      `intent fill expected a click, received ${suggestion.move.kind}`
    )
  }
  return suggestion.move.elementIndex
}

export function namedClickAllowed(goalMetOrMatch: number | undefined): boolean {
  if (goalMetOrMatch === undefined) return true
  return goalMetOrMatch >= GATE_REFUSE_BELOW
}
