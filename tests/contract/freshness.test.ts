import { describe, expect, it } from 'vitest'

import {
  DEFAULT_INTERACTION_CONTEXT_LIMIT,
  DEFAULT_INTERACTION_CONTEXT_TTL_MS,
  InteractionContextStore,
  assertReferenceFresh,
  type ReferenceBindings
} from '../../packages/contract/src/index.js'

const now = Date.parse('2026-07-10T00:00:00.000Z')
const bindings: ReferenceBindings = {
  brokerGeneration: 'broker-1',
  providerGeneration: 'provider-1',
  graphicalSessionId: 'session-1',
  process: { pid: 42, startedAt: '2026-07-10T00:00:00.000Z', executableId: 'fixture.app' },
  appId: 'fixture.app',
  window: { id: 'window-1', ownerPid: 42 },
  snapshotId: 'snapshot-1',
  desktopEpoch: 3
}

describe('interaction contexts and reference freshness', () => {
  it('uses the Orca-compatible cache defaults', () => {
    expect(DEFAULT_INTERACTION_CONTEXT_TTL_MS).toBe(120_000)
    expect(DEFAULT_INTERACTION_CONTEXT_LIMIT).toBe(32)
  })

  it('allows a later process holding the issued bearer context and rejects forged tokens', () => {
    let sequence = 0
    const store = new InteractionContextStore({
      now: () => now,
      tokenFactory: () => `ctx_${String(++sequence).padStart(32, '0')}`
    })
    const issued = store.issue(bindings)

    expect(store.resolve(issued.token, now + 1_000)).toEqual(issued)
    expect(() => store.resolve(`ctx_${'9'.repeat(32)}`, now + 1_000)).toThrowError(
      expect.objectContaining({ code: 'interaction_context_invalid' })
    )
  })

  it('evicts the oldest interaction context at the bounded capacity', () => {
    let sequence = 0
    const store = new InteractionContextStore({
      now: () => now,
      limit: 2,
      tokenFactory: () => `ctx_${String(++sequence).padStart(32, '0')}`
    })
    const first = store.issue(bindings)
    const second = store.issue(bindings)
    const third = store.issue(bindings)

    expect(() => store.resolve(first.token)).toThrowError(
      expect.objectContaining({ code: 'interaction_context_invalid' })
    )
    expect(store.resolve(second.token)).toEqual(second)
    expect(store.resolve(third.token)).toEqual(third)
  })

  it('rejects every stale binding and expiry before dispatch', () => {
    const store = new InteractionContextStore({
      now: () => now,
      tokenFactory: () => `ctx_${'1'.repeat(32)}`
    })
    const context = store.issue(bindings)
    const reference = {
      ref: 'element:7',
      kind: 'element' as const,
      contextToken: context.token,
      ...bindings,
      expiresAt: new Date(now + 120_000).toISOString()
    }

    const mismatches: ReferenceBindings[] = [
      { ...bindings, brokerGeneration: 'broker-2' },
      { ...bindings, providerGeneration: 'provider-2' },
      { ...bindings, graphicalSessionId: 'session-2' },
      { ...bindings, process: { ...bindings.process, pid: 99 } },
      { ...bindings, process: { ...bindings.process, startedAt: '2026-07-10T00:00:01.000Z' } },
      { ...bindings, process: { ...bindings.process, executableId: 'other.app' } },
      { ...bindings, appId: 'other.app' },
      { ...bindings, window: { ...bindings.window, id: 'window-2' } },
      { ...bindings, snapshotId: 'snapshot-2' },
      { ...bindings, desktopEpoch: 4 }
    ]

    for (const current of mismatches) {
      expect(() => assertReferenceFresh(reference, context, current, now + 1_000)).toThrowError(
        expect.objectContaining({ code: 'stale_target' })
      )
    }
    expect(() => assertReferenceFresh(reference, context, bindings, now + 120_001)).toThrowError(
      expect.objectContaining({ code: 'stale_target' })
    )
  })
})
