import type { TreeMove } from './tree.js'
import type { JevAnswers } from './decide.js'

export type EvaluateInput = {
  goal: string
  app?: string
  moves: readonly TreeMove[]
}

export type EvaluateFn = (input: EvaluateInput) => Promise<JevAnswers>

export function recordedEvaluator(answers: JevAnswers): EvaluateFn {
  return async () => answers
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
