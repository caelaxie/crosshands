import { describe, expect, it } from 'vitest'

import {
  CONTRACT_VERSIONS,
  type ReferenceBindings,
  type TargetReference
} from '../../packages/contract/src/index.js'
import { FakeComputerProvider } from '../../packages/provider-testkit/src/index.js'
import { LocalBroker, type BrokerPeer } from '../../packages/runtime/src/index.js'

const peer: BrokerPeer = {
  osIdentity: 'uid:501',
  graphicalSessionId: 'aqua:1',
  verified: true,
  local: true
}

function bindings(overrides: Partial<ReferenceBindings> = {}): ReferenceBindings {
  return {
    brokerGeneration: 'broker-1',
    providerGeneration: 'provider-1',
    graphicalSessionId: peer.graphicalSessionId,
    process: { pid: 42, startedAt: '2026-07-10T00:00:00.000Z', executableId: 'fixture' },
    appId: 'fixture.app',
    window: { id: 'window-1', ownerPid: 42 },
    snapshotId: 'snapshot-1',
    desktopEpoch: 0,
    ...overrides
  }
}

function target(contextToken: string, value: ReferenceBindings): TargetReference {
  return {
    ...value,
    ref: 'element-1',
    kind: 'element',
    contextToken,
    expiresAt: '2099-01-01T00:00:00.000Z'
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    // oxlint-disable-next-line no-await-in-loop -- this polls one shared asynchronous state.
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for fake provider state')
}

describe('local broker', () => {
  it('shares a session broker while issuing portable bearer contexts', async () => {
    const provider = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    })
      .enqueue({
        kind: 'result',
        result: { bindings: bindings(), value: { treeText: 'one' } },
        dispatched: false
      })
      .enqueue({
        kind: 'result',
        result: { bindings: bindings(), value: { treeText: 'two' } },
        dispatched: false
      })
      .enqueue({ kind: 'result', result: { outcome: { state: 'verified' } } })
    const broker = new LocalBroker({
      identity: peer,
      generation: 'broker-1',
      providerFactory: () => provider,
      inspectTarget: async () => ({
        bindings: bindings(),
        appIdentity: { appId: 'fixture.app', executableId: 'fixture' }
      })
    })
    const cli = await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    const mcp = await broker.connect({ peer, versions: CONTRACT_VERSIONS })

    const first = await cli.request({ operation: 'getAppState', input: { app: 'fixture.app' } })
    const second = await mcp.request({ operation: 'getAppState', input: { app: 'fixture.app' } })
    expect(first.context?.token).not.toBe(second.context?.token)

    const action = await mcp.request({
      operation: 'click',
      input: {
        contextToken: first.context!.token,
        target: { kind: 'element', ref: target(first.context!.token, bindings()) }
      }
    })
    expect(action.result).toMatchObject({ outcome: { state: 'verified' } })
    expect(provider.calls).toHaveLength(3)
  })

  it('serializes mutations through publication and advances the epoch', async () => {
    const provider = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    })
      .enqueue({ kind: 'barrier', name: 'first' })
      .enqueue({ kind: 'result', result: { outcome: { state: 'verified' } } })
      .enqueue({ kind: 'result', result: { outcome: { state: 'verified' } } })
    let publicationCount = 0
    const current = bindings()
    const broker = new LocalBroker({
      identity: peer,
      generation: 'broker-1',
      providerFactory: () => provider,
      inspectTarget: async () => ({
        bindings: { ...current, desktopEpoch: broker.desktopEpoch },
        appIdentity: { appId: 'fixture.app', executableId: 'fixture' }
      }),
      publish: async () => {
        publicationCount += 1
      }
    })
    const client = await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    const context = broker.issueContext(current)
    const input = {
      contextToken: context.token,
      target: { kind: 'element', ref: target(context.token, current) }
    }

    const first = client.request({ operation: 'click', input })
    await waitFor(() => provider.calls.length === 1)
    const second = client.request({ operation: 'click', input })
    provider.release('first')

    await expect(first).resolves.toMatchObject({ desktopEpoch: 1 })
    await expect(second).rejects.toMatchObject({ code: 'stale_target' })
    expect(publicationCount).toBe(1)
    expect(provider.calls).toHaveLength(1)
  })

  it('never retries a dispatched mutation timeout', async () => {
    const provider = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    }).enqueue({ kind: 'timeout', dispatched: true })
    const broker = new LocalBroker({
      identity: peer,
      generation: 'broker-1',
      providerFactory: () => provider,
      inspectTarget: async () => ({
        bindings: bindings(),
        appIdentity: { appId: 'fixture.app', executableId: 'fixture' }
      })
    })
    const client = await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    const context = broker.issueContext(bindings())

    const response = await client.request({
      operation: 'click',
      input: {
        contextToken: context.token,
        target: { kind: 'element', ref: target(context.token, bindings()) }
      }
    })
    expect(response.result).toMatchObject({ outcome: { state: 'indeterminate' } })
    expect(provider.calls).toHaveLength(1)
  })

  it('restarts one crashed read, invalidates old contexts, and rejects mismatched peers and versions', async () => {
    const crashed = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    }).enqueue({ kind: 'crash', message: 'read crash' })
    const restarted = new FakeComputerProvider({
      generation: 'provider-2',
      graphicalSessionId: peer.graphicalSessionId
    }).enqueue({
      kind: 'result',
      result: { bindings: bindings({ providerGeneration: 'provider-2' }), value: {} },
      dispatched: false
    })
    const providers = [crashed, restarted]
    const broker = new LocalBroker({
      identity: peer,
      generation: 'broker-1',
      providerFactory: () => providers.shift()!
    })
    const client = await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    const old = broker.issueContext(bindings())

    const response = await client.request({
      operation: 'getAppState',
      input: { app: 'fixture.app' }
    })
    expect(response.context?.providerGeneration).toBe('provider-2')
    expect(() => broker.resolveContext(old.token)).toThrowError(
      expect.objectContaining({ code: 'interaction_context_invalid' })
    )
    await expect(
      broker.connect({
        peer: { ...peer, graphicalSessionId: 'other' },
        versions: CONTRACT_VERSIONS
      })
    ).rejects.toMatchObject({ code: 'session_unavailable' })
    await expect(
      broker.connect({ peer, versions: { ...CONTRACT_VERSIONS, brokerControl: 99 } })
    ).rejects.toMatchObject({ code: 'version_incompatible' })
  })
})
