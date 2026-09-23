import { afterEach, describe, expect, it, vi } from 'vitest'

import { criteria, liveEvaluator } from '../../packages/cli/src/intent/evaluate.js'
import {
  clickableMoves,
  parseTreeMoves,
  type TreeMove
} from '../../packages/cli/src/intent/tree.js'

const moves = clickableMoves(
  parseTreeMoves(`0 standard window Notes
	68 button New Note
`)
)

afterEach(() => {
  vi.unstubAllGlobals()
})

function move(elementIndex: number, role: string, label: string): TreeMove {
  return {
    elementIndex,
    role,
    label,
    line: `${elementIndex} ${role} ${label}`,
    disabled: false,
    clickable: true,
    settable: role === 'text field' || role === 'text area'
  }
}

const eighty = 'button NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN'

describe('criteria', () => {
  it('keeps a short control name', () => {
    expect(criteria([move(68, 'button', 'New Note')])).toEqual({ '68': 'button New Note' })
  })

  it('drops the field value and wrapped lines, and caps a long name at 80 characters', () => {
    expect(
      criteria([
        move(40, 'text field', 'Compose, Value: CANARY-ESSAY'),
        move(41, 'text area', 'Body\nCANARY-AREA keeps going'),
        move(12, 'button', 'N'.repeat(74)),
        move(7, 'button', 'N'.repeat(73)),
        move(3, 'text field', ', Value: CANARY-ONLY'),
        move(42, 'text field', '(selected, settable) Compose, Value: the essay'),
        move(43, 'text field', 'Address, Placeholder: Search'),
        move(44, 'button', 'Save, Secondary Actions: press'),
        move(45, 'heading', 'Title, Description: subtitle'),
        move(46, 'text', 'Note, Text: body')
      ])
    ).toEqual({
      '40': 'text field Compose',
      '41': 'text area Body',
      '12': eighty,
      '7': eighty,
      '3': 'text field',
      '42': 'text field (selected, settable) Compose',
      '43': 'text field Address',
      '44': 'button Save',
      '45': 'heading Title',
      '46': 'text Note'
    })
  })

  it('posts those short names from a parsed accessibility tree', () => {
    const essay = `CANARY-ESSAY ${'word '.repeat(40)}`
    const tree = [
      '0 standard window Chat',
      '\t13 button Send',
      `\t40 text field Compose, Value: ${essay}`,
      '\t42 text field (selected, settable) Compose, Value: the essay',
      '\t41 text area Note',
      'the rest of the note is CANARY-AREA and has no comma',
      `\t12 button ${'N'.repeat(90)}`
    ].join('\n')
    expect(criteria(clickableMoves(parseTreeMoves(tree)))).toEqual({
      '13': 'button Send',
      '40': 'text field Compose',
      '42': 'text field (selected, settable) Compose',
      '41': 'text area Note',
      '12': eighty
    })
  })
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
      http: { status: 503, responseBytes: 4 },
      errorBody: 'nope'
    })
  })

  it('scrubs and caps a non-2xx body and leaves a 2xx body off the error', async () => {
    const secret = `sk-test Bearer live-token ${'y'.repeat(600)}`
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(secret, { status: 502 }))
    )
    await expect(
      liveEvaluator('sk-test')({ goal: 'Make a new note in Notes.', moves })
    ).rejects.toMatchObject({
      errorBodyTruncated: true,
      http: { status: 502 }
    })
    try {
      await liveEvaluator('sk-test')({ goal: 'Make a new note in Notes.', moves })
    } catch (cause) {
      expect(cause).toMatchObject({ errorBodyTruncated: true })
      const body = String((cause as { errorBody?: string }).errorBody)
      expect(body).toHaveLength(512)
      expect(body).not.toContain('sk-test')
      expect(body).not.toContain('live-token')
      expect(body).toContain('[redacted]')
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"answers":{}}', { status: 200 }))
    )
    const ok = await liveEvaluator('sk-test')({ goal: 'Make a new note in Notes.', moves })
    expect(ok).not.toHaveProperty('errorBody')
    expect(JSON.stringify(ok.http)).not.toContain('Make a new note')
  })

  it('sends the short control name in the state and in both choice questions', async () => {
    const fetchMock = vi.fn(async () => new Response('{"answers":{}}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const ranked = [
      move(68, 'button', 'New Note'),
      move(40, 'text field', `Compose, Value: CANARY-ESSAY ${'word '.repeat(40)}`)
    ]
    await liveEvaluator('sk-test')({
      goal: 'Open the compose field.',
      app: 'com.github.Electron',
      moves: ranked
    })
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(String(request.body)) as {
      state: { goal: string; app: string; clickable: Record<string, string> }
      questions: {
        click_which: { criteria: Record<string, string> }
        setvalue_which: { criteria: Record<string, string> }
      }
    }
    const posted = { '68': 'button New Note', '40': 'text field Compose' }
    expect(body.state.goal).toBe('Open the compose field.')
    expect(body.state.app).toBe('com.github.Electron')
    expect(body.state.clickable).toEqual(posted)
    expect(body.questions.click_which.criteria).toEqual(posted)
    expect(body.questions.setvalue_which.criteria).toEqual(posted)
    expect(JSON.stringify(body)).not.toContain('CANARY-ESSAY')
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
