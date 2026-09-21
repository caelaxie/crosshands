import { describe, expect, it } from 'vitest'

import { dispatchPublicOperation } from '../../packages/cli/src/intent/dispatch.js'
import { recordedEvaluator } from '../../packages/cli/src/intent/evaluate.js'
import { parseJevEnv, brokerSpawnEnv, hashGoal } from '../../packages/cli/src/intent/env.js'
import { parseOperationInput, parsePublicInput } from '../../packages/contract/src/index.js'

const token = `ctx_${'a'.repeat(32)}`
const treeText = `0 standard window Notes
	65 button Add Folder
	68 button New Note
`

function snapshotResult(text = treeText) {
  return {
    context: {
      token,
      issuedAt: '2026-09-21T12:00:00.000Z',
      expiresAt: '2026-09-21T12:02:00.000Z',
      brokerGeneration: 'broker-1',
      providerGeneration: 'provider-1',
      graphicalSessionId: 'session-1',
      process: { pid: 1, startedAt: '2026-09-21T00:00:00.000Z', executableId: '/Notes' },
      appId: 'com.apple.Notes',
      window: { id: '5087', ownerPid: 1 },
      snapshotId: 'snap-1',
      desktopEpoch: 0
    },
    snapshot: {
      id: 'snap-1',
      app: {
        id: 'com.apple.Notes',
        name: 'Notes',
        bundleId: 'com.apple.Notes',
        pid: 1,
        isRunning: true
      },
      window: {
        id: '5087',
        appId: 'com.apple.Notes',
        title: 'Notes',
        index: 0,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        minimized: false
      },
      treeText: text,
      elementCount: 3,
      focusedElementRef: null,
      desktopEpoch: 0
    },
    screenshot: null,
    issues: []
  }
}

describe('Jev env', () => {
  it('stays off when only a TypeSafe key is set', () => {
    expect(parseJevEnv({ TYPESAFE_API_KEY: 'sk-test' })).toEqual({ kind: 'off' })
  })

  it('fails closed when enabled without a key', () => {
    expect(parseJevEnv({ CROSSHANDS_JEV: '1' })).toEqual({
      kind: 'fail_closed',
      reason: 'missing_key'
    })
  })

  it('strips Jev and TypeSafe names from broker spawn env', () => {
    const stripped = brokerSpawnEnv({
      CROSSHANDS_JEV: '1',
      TYPESAFE_API_KEY: 'sk-test',
      TYPESAFE_BASE_URL: 'https://example.invalid',
      PATH: '/bin'
    })
    expect(stripped.CROSSHANDS_JEV).toBeUndefined()
    expect(stripped.TYPESAFE_API_KEY).toBeUndefined()
    expect(stripped.TYPESAFE_BASE_URL).toBeUndefined()
    expect(stripped.PATH).toBe('/bin')
  })
})

describe('public vs broker input', () => {
  it('rejects goal on the broker getAppState schema', () => {
    expect(() =>
      parseOperationInput('getAppState', { app: 'Notes', goal: 'Make a new note in Notes.' })
    ).toThrow()
  })

  it('accepts a per-call goal on the public schema', () => {
    expect(
      parsePublicInput('getAppState', { app: 'Notes', goal: 'Make a new note in Notes.' })
    ).toMatchObject({ app: 'Notes', goal: 'Make a new note in Notes.' })
  })

  it('requires a goal for intent targets', () => {
    expect(() =>
      parsePublicInput('click', { contextToken: token, target: { kind: 'intent' } })
    ).toThrow()
  })
})

describe('dispatchPublicOperation', () => {
  it('strips goal before the broker when Jev is off', async () => {
    const calls: Array<{ operation: string; input: unknown }> = []
    const result = await dispatchPublicOperation(
      {
        request: async (operation, input) => {
          calls.push({ operation, input })
          return snapshotResult()
        }
      },
      'getAppState',
      { app: 'Notes', goal: 'Make a new note in Notes.', captureScreenshot: false },
      { env: {} }
    )
    expect(calls).toEqual([
      {
        operation: 'getAppState',
        input: { app: 'Notes', captureScreenshot: false }
      }
    ])
    expect(result).not.toHaveProperty('suggestion')
  })

  it('rejects intent clicks when Jev is off', async () => {
    await expect(
      dispatchPublicOperation(
        { request: async () => ({}) },
        'click',
        {
          contextToken: token,
          target: { kind: 'intent' },
          goal: 'Make a new note in Notes.'
        },
        { env: {} }
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('attaches an untrusted suggestion when Jev is on', async () => {
    const result = await dispatchPublicOperation(
      {
        request: async () => snapshotResult()
      },
      'getAppState',
      { app: 'Notes', goal: 'Make a new note in Notes.', captureScreenshot: false },
      {
        env: { CROSSHANDS_JEV: '1', TYPESAFE_API_KEY: 'sk-test' },
        evaluate: recordedEvaluator({
          move: 'click',
          clickWhich: '68',
          confidence: 0.88
        })
      }
    )
    expect(result).toMatchObject({
      suggestion: {
        untrusted: true,
        move: { kind: 'click', elementIndex: 68 },
        label: 'button New Note'
      }
    })
  })

  it('fills an intent click from a fresh look', async () => {
    const calls: Array<{ operation: string; input: unknown }> = []
    const result = await dispatchPublicOperation(
      {
        request: async (operation, input) => {
          calls.push({ operation, input })
          if (operation === 'getAppState') return snapshotResult()
          return { outcome: { state: 'indeterminate', reason: 'synthetic_input' } }
        }
      },
      'click',
      {
        contextToken: token,
        target: { kind: 'intent' },
        goal: 'Make a new note in Notes.',
        captureScreenshot: false
      },
      {
        env: { CROSSHANDS_JEV: '1', TYPESAFE_API_KEY: 'sk-test' },
        evaluate: recordedEvaluator({ move: 'click', clickWhich: '68', confidence: 0.9 })
      }
    )
    expect(calls[0]).toEqual({
      operation: 'getAppState',
      input: { contextToken: token, captureScreenshot: false }
    })
    expect(calls[1]?.operation).toBe('click')
    expect(calls[1]?.input).toMatchObject({
      contextToken: token,
      target: { kind: 'element', elementIndex: 68 }
    })
    expect(JSON.stringify(calls[1]?.input)).not.toContain('Make a new note')
    expect(result).toMatchObject({
      outcome: { state: 'indeterminate' },
      resolvedTarget: { kind: 'element', elementIndex: 68 }
    })
  })

  it('hashes the goal in the Jev log', () => {
    expect(hashGoal('Make a new note in Notes.')).toBe(
      'e8217506e3e2c5e5bbae2d68baae9ff725c2f1553dee2926613c5b9fbcad54c1'
    )
  })
})
