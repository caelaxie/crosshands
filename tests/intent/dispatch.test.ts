import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { dispatchPublicOperation } from '../../packages/cli/src/intent/dispatch.js'
import type { EvaluateFn, JevAnswers } from '../../packages/cli/src/intent/evaluate.js'
import { parseJevEnv } from '../../packages/cli/src/intent/env.js'
import { createJevLogger, hashGoal } from '../../packages/cli/src/intent/log.js'
import { brokerSpawnEnv } from '../../packages/cli/src/local-client.js'
import {
  ERROR_CATALOG,
  PUBLIC_ERROR_CATALOG,
  parseOperationInput,
  parsePublicInput,
  toBrokerInput
} from '../../packages/contract/src/index.js'

const token = `ctx_${'a'.repeat(32)}`
const treeText = `0 standard window Notes
	65 button Add Folder
	68 button New Note
	77 search text field Title
`

function recordedEvaluator(answers: JevAnswers): EvaluateFn {
  return async () => answers
}

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
      elementCount: 4,
      focusedElementRef: null,
      desktopEpoch: 0
    },
    screenshot: null,
    issues: []
  }
}

function envelope(result: unknown) {
  return {
    requestId: 'broker-1',
    result,
    desktopEpoch: 0,
    providerGeneration: 'provider-1'
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

  it('rejects unbound intent before broker parse', () => {
    expect(() =>
      toBrokerInput('click', {
        contextToken: token,
        target: { kind: 'intent' },
        goal: 'Make a new note in Notes.'
      })
    ).toThrow(/bound before broker parse/)
  })

  it('keeps Jev codes off the broker error catalog', () => {
    expect(ERROR_CATALOG).not.toHaveProperty('goal_mismatch')
    expect(ERROR_CATALOG).not.toHaveProperty('policy_unavailable')
    expect(ERROR_CATALOG).not.toHaveProperty('intent_unavailable')
    expect(PUBLIC_ERROR_CATALOG).toMatchObject({
      goal_mismatch: { retry: true },
      policy_unavailable: { retry: true },
      intent_unavailable: { retry: false }
    })
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

  it('unwraps a BrokerResponse envelope before ranking', async () => {
    const result = await dispatchPublicOperation(
      {
        request: async () => envelope(snapshotResult())
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
      suggestion: { move: { kind: 'click', elementIndex: 68 } }
    })
    expect(result).not.toHaveProperty('requestId')
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

  it('fills intent setValue from a setValue suggestion', async () => {
    const calls: Array<{ operation: string; input: unknown }> = []
    const result = await dispatchPublicOperation(
      {
        request: async (operation, input) => {
          calls.push({ operation, input })
          if (operation === 'getAppState') return snapshotResult()
          return { outcome: { state: 'indeterminate', reason: 'synthetic_input' } }
        }
      },
      'setValue',
      {
        contextToken: token,
        target: { kind: 'intent' },
        value: 'New note',
        goal: 'Name the note',
        captureScreenshot: false
      },
      {
        env: { CROSSHANDS_JEV: '1', TYPESAFE_API_KEY: 'sk-test' },
        evaluate: recordedEvaluator({
          move: 'setValue',
          setValueWhich: '77',
          confidence: 0.9
        })
      }
    )
    expect(calls[1]?.input).toMatchObject({
      target: { kind: 'element', elementIndex: 77 },
      value: 'New note'
    })
    expect(result).toMatchObject({
      resolvedTarget: { kind: 'element', elementIndex: 77 }
    })
  })

  it('does not bind a click suggestion onto setValue intent', async () => {
    const result = await dispatchPublicOperation(
      {
        request: async (operation) => {
          if (operation === 'getAppState') return snapshotResult()
          return { outcome: { state: 'verified' } }
        }
      },
      'setValue',
      {
        contextToken: token,
        target: { kind: 'intent' },
        value: 'New note',
        goal: 'Name the note'
      },
      {
        env: { CROSSHANDS_JEV: '1', TYPESAFE_API_KEY: 'sk-test' },
        evaluate: recordedEvaluator({ move: 'click', clickWhich: '68', confidence: 0.9 })
      }
    )
    expect(result).toMatchObject({
      outcome: { state: 'not_attempted', error: { code: 'policy_unavailable' } }
    })
  })

  it('refuses a named click that does not match the ranked target', async () => {
    const result = await dispatchPublicOperation(
      {
        request: async (operation) => {
          if (operation === 'getAppState') return snapshotResult()
          return { outcome: { state: 'verified' } }
        }
      },
      'click',
      {
        contextToken: token,
        target: { kind: 'element', elementIndex: 65 },
        goal: 'Make a new note in Notes.'
      },
      {
        env: { CROSSHANDS_JEV: '1', TYPESAFE_API_KEY: 'sk-test' },
        evaluate: recordedEvaluator({ move: 'click', clickWhich: '68', confidence: 0.9 })
      }
    )
    expect(result).toMatchObject({
      outcome: { state: 'not_attempted', error: { code: 'goal_mismatch' } }
    })
  })

  it('hashes the goal in the Jev log and omits secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosshands-jev-'))
    const log = createJevLogger('session-test', { CROSSHANDS_DIAGNOSTICS_DIR: directory })
    const goal = 'Make a new note in Notes.'
    await dispatchPublicOperation(
      { request: async () => snapshotResult() },
      'getAppState',
      { app: 'Notes', goal, captureScreenshot: false },
      {
        env: { CROSSHANDS_JEV: '1', TYPESAFE_API_KEY: 'sk-test' },
        evaluate: recordedEvaluator({ move: 'click', clickWhich: '68', confidence: 0.88 }),
        log
      }
    )
    log.emit({
      kind: 'jev.http',
      goal,
      apiKey: 'sk-test',
      treeText,
      text: 'secret-text',
      value: 'secret-value'
    })
    await log.close()
    const files = await readdir(directory)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^jev-[0-9a-f-]+\.jsonl$/)
    const body = await readFile(join(directory, files[0]!), 'utf8')
    expect(body).toContain(hashGoal(goal))
    expect(body).not.toContain(goal)
    expect(body).not.toContain('sk-test')
    expect(body).not.toContain('secret-text')
    expect(body).not.toContain('secret-value')
    expect(body).not.toContain('button New Note')
  })

  it('hashes the goal in the Jev log', () => {
    expect(hashGoal('Make a new note in Notes.')).toBe(
      'e8217506e3e2c5e5bbae2d68baae9ff725c2f1553dee2926613c5b9fbcad54c1'
    )
  })
})
