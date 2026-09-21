import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { dispatchPublicOperation } from '../../packages/cli/src/intent/dispatch.js'
import {
  JevEvaluateError,
  type EvaluateFn,
  type JevAnswers,
  type JevHttpStats
} from '../../packages/cli/src/intent/evaluate.js'
import { parseJevEnv } from '../../packages/cli/src/intent/env.js'
import { createJevLogger, hashGoal, type JevRecord } from '../../packages/cli/src/intent/log.js'
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

function recordedEvaluator(answers: JevAnswers & { http?: JevHttpStats }): EvaluateFn {
  const { http, ...rest } = answers
  return async () => ({
    answers: rest,
    ...(http === undefined ? {} : { http })
  })
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

async function readJevRecords(directory: string) {
  const files = await readdir(directory)
  expect(files).toHaveLength(1)
  return (await readFile(join(directory, files[0]!), 'utf8'))
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function recordOf(records: Record<string, unknown>[], kind: string) {
  const match = records.find((record) => record.kind === kind)
  expect(match, `missing ${kind}`).toBeDefined()
  return match!
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
    const omitRecord: JevRecord & Record<string, unknown> = {
      kind: 'jev.http',
      callId: 'omit-test',
      operation: 'getAppState',
      snapshotId: 'snap-1',
      phase: 'observe',
      goal,
      status: 200,
      durationMs: 1,
      requestBytes: 1,
      responseBytes: 1,
      candidateCount: 1
    }
    omitRecord.apiKey = 'sk-test'
    omitRecord.treeText = treeText
    omitRecord.text = 'secret-text'
    omitRecord.value = 'secret-value'
    log.emit(omitRecord)
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

  it('records rank sizes and TypeSafe timings without the goal or tree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosshands-jev-'))
    const log = createJevLogger('session-test', { CROSSHANDS_DIAGNOSTICS_DIR: directory })
    const goal = 'Make a new note in Notes.'
    await dispatchPublicOperation(
      { request: async () => snapshotResult() },
      'getAppState',
      { app: 'Notes', goal, captureScreenshot: false },
      {
        env: { CROSSHANDS_JEV: '1', TYPESAFE_API_KEY: 'sk-test' },
        evaluate: recordedEvaluator({
          move: 'click',
          clickWhich: '68',
          confidence: 0.88,
          http: { status: 200, durationMs: 42, requestBytes: 1200, responseBytes: 80 }
        }),
        log
      }
    )
    await log.close()
    const records = await readJevRecords(directory)
    const http = recordOf(records, 'jev.http')
    const decision = recordOf(records, 'jev.decision')
    const call = recordOf(records, 'jev.call')
    expect(http).toMatchObject({
      snapshotId: 'snap-1',
      operation: 'getAppState',
      phase: 'observe',
      status: 200,
      durationMs: 42,
      requestBytes: 1200,
      responseBytes: 80,
      candidateCount: 3,
      goalSha256: hashGoal(goal)
    })
    expect(decision).toMatchObject({
      snapshotId: 'snap-1',
      operation: 'getAppState',
      phase: 'observe',
      app: 'com.apple.Notes',
      move: 'click',
      elementIndex: 68,
      confidence: 0.88,
      goalChars: goal.length,
      treeChars: treeText.length,
      elementCount: 4,
      candidateCount: 3,
      goalSha256: hashGoal(goal)
    })
    expect(call).toMatchObject({
      operation: 'getAppState',
      phase: 'observe',
      httpMs: 42,
      brokerCalls: 1,
      ranks: 1,
      goalSha256: hashGoal(goal)
    })
    expect(call).not.toHaveProperty('bound')
    expect(call).not.toHaveProperty('error')
    expect(call.durationMs).toBeGreaterThanOrEqual(0)
    expect(call.callId).toEqual(http.callId)
    expect(call.callId).toEqual(decision.callId)
    expect(decision.parseMs).toBeGreaterThanOrEqual(0)
    expect(decision.evaluateMs).toBeGreaterThanOrEqual(0)
    expect(decision).not.toHaveProperty('goal')
    expect(decision).not.toHaveProperty('label')
    expect(decision).not.toHaveProperty('treeText')
    const body = JSON.stringify(records)
    expect(body).not.toContain(goal)
    expect(body).not.toContain('button New Note')
  })

  it('logs TypeSafe failures and fail-closes the look', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosshands-jev-'))
    const log = createJevLogger('session-test', { CROSSHANDS_DIAGNOSTICS_DIR: directory })
    const goal = 'Make a new note in Notes.'
    const result = await dispatchPublicOperation(
      { request: async () => snapshotResult() },
      'getAppState',
      { app: 'Notes', goal, captureScreenshot: false },
      {
        env: { CROSSHANDS_JEV: '1', TYPESAFE_API_KEY: 'sk-test' },
        evaluate: async () => {
          throw new JevEvaluateError('TypeSafe HTTP 503', {
            status: 503,
            durationMs: 15,
            requestBytes: 900,
            responseBytes: 4
          })
        },
        log
      }
    )
    await log.close()
    expect(result).toMatchObject({
      issues: [expect.objectContaining({ code: 'policy_unavailable' })]
    })
    expect(result).not.toHaveProperty('suggestion')
    const records = await readJevRecords(directory)
    expect(recordOf(records, 'jev.http')).toMatchObject({
      status: 503,
      durationMs: 15,
      requestBytes: 900,
      responseBytes: 4,
      phase: 'observe',
      operation: 'getAppState'
    })
    expect(recordOf(records, 'jev.call')).toMatchObject({
      operation: 'getAppState',
      phase: 'observe',
      httpMs: 15,
      brokerCalls: 1,
      ranks: 1,
      error: 'policy_unavailable'
    })
    expect(recordOf(records, 'jev.call')).not.toHaveProperty('bound')
    expect(records.find((record) => record.kind === 'jev.decision')).toBeUndefined()
    expect(JSON.stringify(records)).not.toContain(goal)
  })

  it('records a bound intent click as one public call with a hidden look', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosshands-jev-'))
    const log = createJevLogger('session-test', { CROSSHANDS_DIAGNOSTICS_DIR: directory })
    const goal = 'Make a new note in Notes.'
    const result = await dispatchPublicOperation(
      {
        request: async (operation) => {
          if (operation === 'getAppState') return snapshotResult()
          return { outcome: { state: 'indeterminate', reason: 'synthetic_input' } }
        }
      },
      'click',
      {
        contextToken: token,
        target: { kind: 'intent' },
        goal,
        captureScreenshot: false
      },
      {
        env: { CROSSHANDS_JEV: '1', TYPESAFE_API_KEY: 'sk-test' },
        evaluate: recordedEvaluator({
          move: 'click',
          clickWhich: '68',
          confidence: 0.9,
          http: { status: 200, durationMs: 30, requestBytes: 800, responseBytes: 40 }
        }),
        log
      }
    )
    await log.close()
    expect(result).toMatchObject({
      outcome: { state: 'indeterminate' },
      resolvedTarget: { kind: 'element', elementIndex: 68 }
    })
    const records = await readJevRecords(directory)
    expect(recordOf(records, 'jev.decision')).toMatchObject({
      operation: 'click',
      phase: 'bind',
      elementIndex: 68
    })
    expect(recordOf(records, 'jev.call')).toMatchObject({
      operation: 'click',
      phase: 'bind',
      bound: true,
      brokerCalls: 2,
      ranks: 1,
      httpMs: 30
    })
    expect(recordOf(records, 'jev.call')).not.toHaveProperty('error')
    expect(JSON.stringify(records)).not.toContain(goal)
  })

  it('records an unbound named click as bound false', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosshands-jev-'))
    const log = createJevLogger('session-test', { CROSSHANDS_DIAGNOSTICS_DIR: directory })
    const goal = 'Make a new note in Notes.'
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
        goal
      },
      {
        env: { CROSSHANDS_JEV: '1', TYPESAFE_API_KEY: 'sk-test' },
        evaluate: recordedEvaluator({ move: 'click', clickWhich: '68', confidence: 0.9 }),
        log
      }
    )
    await log.close()
    expect(result).toMatchObject({
      outcome: { state: 'not_attempted', error: { code: 'goal_mismatch' } }
    })
    const records = await readJevRecords(directory)
    expect(recordOf(records, 'jev.decision')).toMatchObject({
      operation: 'click',
      phase: 'named',
      elementIndex: 68
    })
    expect(recordOf(records, 'jev.call')).toMatchObject({
      operation: 'click',
      phase: 'named',
      brokerCalls: 1,
      ranks: 1,
      error: 'goal_mismatch',
      httpMs: 0
    })
    expect(recordOf(records, 'jev.call')).not.toHaveProperty('bound')
  })

  it('records fail-closed observe without a rank phase', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosshands-jev-'))
    const log = createJevLogger('session-test', { CROSSHANDS_DIAGNOSTICS_DIR: directory })
    const result = await dispatchPublicOperation(
      { request: async () => snapshotResult() },
      'getAppState',
      { app: 'Notes', goal: 'Make a new note in Notes.', captureScreenshot: false },
      { env: { CROSSHANDS_JEV: '1' }, log }
    )
    await log.close()
    expect(result).toMatchObject({
      issues: [expect.objectContaining({ code: 'policy_unavailable' })]
    })
    const call = recordOf(await readJevRecords(directory), 'jev.call')
    expect(call).toMatchObject({
      operation: 'getAppState',
      error: 'policy_unavailable',
      brokerCalls: 1,
      ranks: 0,
      httpMs: 0
    })
    expect(call).not.toHaveProperty('phase')
    expect(call).not.toHaveProperty('bound')
  })

  it('records fail-closed intent fill on jev.call', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosshands-jev-'))
    const log = createJevLogger('session-test', { CROSSHANDS_DIAGNOSTICS_DIR: directory })
    await expect(
      dispatchPublicOperation(
        { request: async () => snapshotResult() },
        'click',
        {
          contextToken: token,
          target: { kind: 'intent' },
          goal: 'Make a new note in Notes.'
        },
        { env: { CROSSHANDS_JEV: '1' }, log }
      )
    ).rejects.toMatchObject({ code: 'intent_unavailable' })
    await log.close()
    const call = recordOf(await readJevRecords(directory), 'jev.call')
    expect(call).toMatchObject({
      operation: 'click',
      error: 'intent_unavailable',
      brokerCalls: 0,
      ranks: 0,
      httpMs: 0
    })
    expect(call).not.toHaveProperty('bound')
    expect(call).not.toHaveProperty('phase')
  })

  it('hashes the goal in the Jev log', () => {
    expect(hashGoal('Make a new note in Notes.')).toBe(
      'e8217506e3e2c5e5bbae2d68baae9ff725c2f1553dee2926613c5b9fbcad54c1'
    )
  })
})
