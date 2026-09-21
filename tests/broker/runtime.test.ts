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

function observedState(value: ReferenceBindings, treeText: string, issues?: unknown[]) {
  return {
    bindings: value,
    snapshot: {
      id: value.snapshotId,
      app: {
        id: value.appId,
        name: 'Fixture',
        bundleId: value.appId,
        pid: value.process.pid,
        isRunning: true
      },
      window: {
        id: value.window.id,
        appId: value.appId,
        title: 'Fixture Window',
        index: 0,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        minimized: false
      },
      treeText,
      elementCount: 1,
      focusedElementRef: null,
      desktopEpoch: value.desktopEpoch
    },
    screenshot: null,
    ...(issues === undefined ? {} : { issues })
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
  it('blocks sensitive app observations before provider capture', async () => {
    const provider = new FakeComputerProvider({ graphicalSessionId: peer.graphicalSessionId })
    const broker = new LocalBroker({ identity: peer, providerFactory: () => provider })
    const client = await broker.connect({ peer, versions: CONTRACT_VERSIONS })

    await expect(
      client.request({ operation: 'getAppState', input: { app: 'org.keepassxc.keepassxc' } })
    ).rejects.toMatchObject({ code: 'app_blocked' })
    expect(provider.calls).toHaveLength(0)
  })

  it('surfaces provider observation errors with their contract code', async () => {
    const provider = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    }).enqueue({
      kind: 'error',
      code: 'app_not_found',
      message: "app 'fixture.app' is not running",
      dispatched: false
    })
    const broker = new LocalBroker({
      identity: peer,
      generation: 'broker-1',
      providerFactory: () => provider
    })
    const client = await broker.connect({ peer, versions: CONTRACT_VERSIONS })

    await expect(
      client.request({ operation: 'getAppState', input: { app: 'fixture.app' } })
    ).rejects.toMatchObject({
      code: 'app_not_found',
      message: "app 'fixture.app' is not running",
      retry: true,
      remediation: 'refresh_apps'
    })
    expect(provider.calls).toHaveLength(1)
  })

  it('shares a session broker while issuing portable bearer contexts', async () => {
    const provider = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    })
      .enqueue({
        kind: 'result',
        result: observedState(bindings(), 'one'),
        dispatched: false
      })
      .enqueue({
        kind: 'result',
        result: observedState(bindings(), 'two', [
          {
            code: 'permission_denied',
            message: 'Screen Recording permission is required',
            retry: false,
            remediation: 'grant_permission'
          }
        ]),
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
    expect(first.result).toMatchObject({ issues: [] })
    expect(second.result).toMatchObject({ issues: [{ code: 'permission_denied' }] })

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

  it('rewrites getAppState context tokens to the bound app and window', async () => {
    const current = bindings()
    const provider = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    }).enqueue({
      kind: 'result',
      result: observedState(current, 'refreshed'),
      dispatched: false
    })
    const broker = new LocalBroker({
      identity: peer,
      generation: 'broker-1',
      providerFactory: () => provider
    })
    const client = await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    const context = broker.issueContext(current)
    const refreshed = await client.request({
      operation: 'getAppState',
      input: { contextToken: context.token, captureScreenshot: false }
    })
    expect(provider.calls[0]?.input).toEqual({
      app: 'fixture.app',
      window: { id: 'window-1' },
      captureScreenshot: false
    })
    expect(refreshed.result).toMatchObject({ snapshot: { treeText: 'refreshed' } })
  })

  it('binds context-window shorthand before provider identity inspection', async () => {
    const current = bindings()
    const provider = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    }).enqueue({ kind: 'result', result: { outcome: { state: 'verified' } } })
    let inspectedInput: unknown
    const broker = new LocalBroker({
      identity: peer,
      generation: 'broker-1',
      providerFactory: () => provider,
      inspectTarget: async (_operation, input) => {
        inspectedInput = input
        return {
          bindings: current,
          appIdentity: { appId: current.appId, executableId: current.process.executableId }
        }
      }
    })
    const client = await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    const context = broker.issueContext(current)

    await client.request({
      operation: 'pressKey',
      input: {
        contextToken: context.token,
        target: { kind: 'context-window' },
        key: 'Enter'
      }
    })

    expect(inspectedInput).toMatchObject({
      target: {
        kind: 'window',
        contextToken: context.token,
        process: current.process,
        window: current.window
      }
    })
    expect(provider.calls[0]?.input).toMatchObject({
      target: { kind: 'window', process: current.process }
    })
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
      result: observedState(bindings({ providerGeneration: 'provider-2' }), 'restarted'),
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
