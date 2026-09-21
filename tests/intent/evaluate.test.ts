import { afterEach, describe, expect, it, vi } from 'vitest'

import { liveEvaluator } from '../../packages/cli/src/intent/evaluate.js'
import { clickableMoves, parseTreeMoves } from '../../packages/cli/src/intent/tree.js'

const moves = clickableMoves(
  parseTreeMoves(`0 standard window Notes
	68 button New Note
`)
)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('liveEvaluator', () => {
  it('returns http size and timing stats without echoing the goal', async () => {
    const payload = JSON.stringify({
      answers: {
        move: { type: 'choice', choice: 'click', confidence: 0.9 },
        click_which: { type: 'choice', choice: '68' }
      }
    })
    const fetchMock = vi.fn(
      async () =>
        new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } })
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await liveEvaluator('sk-test')({
      goal: 'Make a new note in Notes.',
      app: 'Notes',
      moves
    })
    expect(result.answers).toMatchObject({ move: 'click', clickWhich: '68', confidence: 0.9 })
    expect(result.http).toMatchObject({
      status: 200,
      responseBytes: Buffer.byteLength(payload)
    })
    expect(result.http?.requestBytes).toBeGreaterThan(0)
    expect(result.http?.durationMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(result.http)).not.toContain('Make a new note')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.typesafe.ai/v1/systemone')
  })

  it('attaches http stats to a non-2xx TypeSafe response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 }))
    )
    await expect(
      liveEvaluator('sk-test')({
        goal: 'Make a new note in Notes.',
        moves
      })
    ).rejects.toMatchObject({
      name: 'JevEvaluateError',
      http: { status: 503, responseBytes: 4 }
    })
  })

  it('records a network failure as status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed')
      })
    )
    await expect(
      liveEvaluator('sk-test')({ goal: 'Make a new note in Notes.', moves })
    ).rejects.toMatchObject({
      http: { status: 0, responseBytes: 0 }
    })
  })
})
