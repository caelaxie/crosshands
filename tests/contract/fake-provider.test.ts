import { describe, expect, it } from 'vitest'

import { FakeComputerProvider } from '../../packages/provider-testkit/src/index.js'

describe('deterministic fake provider', () => {
  it('scripts rerenders, identity changes, permissions, sessions, interleavings, and outcomes', async () => {
    const provider = new FakeComputerProvider()
      .enqueue({ kind: 'rerender', snapshotId: 'snapshot-2' })
      .enqueue({ kind: 'identity-swap', appId: 'other.app' })
      .enqueue({ kind: 'permission-change', permission: 'accessibility', state: 'denied' })
      .enqueue({ kind: 'session-change', graphicalSessionId: 'session-2' })
      .enqueue({ kind: 'barrier', name: 'mutation-slot' })
      .enqueue({ kind: 'result', result: { outcome: { state: 'verified' } } })

    await provider.dispatch({
      requestId: '1',
      operation: 'getAppState',
      input: {},
      deadlineAt: Infinity
    })
    await provider.dispatch({
      requestId: '2',
      operation: 'getAppState',
      input: {},
      deadlineAt: Infinity
    })
    await provider.dispatch({
      requestId: '3',
      operation: 'permissions',
      input: {},
      deadlineAt: Infinity
    })
    await provider.dispatch({
      requestId: '4',
      operation: 'getAppState',
      input: {},
      deadlineAt: Infinity
    })
    const waiting = provider.dispatch({
      requestId: '5',
      operation: 'click',
      input: {},
      deadlineAt: Infinity
    })
    provider.release('mutation-slot')

    await expect(waiting).resolves.toMatchObject({ result: { outcome: { state: 'verified' } } })
    expect(provider.state).toMatchObject({
      snapshotId: 'snapshot-2',
      appId: 'other.app',
      graphicalSessionId: 'session-2',
      permissions: { accessibility: 'denied' }
    })
  })

  it('scripts timeouts and crashes without reporting success', async () => {
    const provider = new FakeComputerProvider()
      .enqueue({ kind: 'timeout' })
      .enqueue({ kind: 'crash', message: 'fixture crash' })

    await expect(
      provider.dispatch({ requestId: '1', operation: 'click', input: {}, deadlineAt: 0 })
    ).resolves.toMatchObject({ error: { code: 'timeout' }, dispatched: true })
    await expect(
      provider.dispatch({ requestId: '2', operation: 'click', input: {}, deadlineAt: Infinity })
    ).rejects.toThrow('fixture crash')
  })
})
