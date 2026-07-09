import { describe, expect, it } from 'vitest'

import { CONTRACT_VERSIONS } from '../../packages/contract/src/index.js'
import { FakeComputerProvider } from '../../packages/provider-testkit/src/index.js'
import { ProviderSupervisor } from '../../packages/runtime/src/index.js'

describe('provider supervision', () => {
  it('validates the provider handshake and session before dispatch', async () => {
    const wrongSession = new FakeComputerProvider({ graphicalSessionId: 'other-session' })
    const supervisor = new ProviderSupervisor({
      providerFactory: () => wrongSession,
      graphicalSessionId: 'session-1'
    })
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'session_unavailable' })
    expect(wrongSession.calls).toHaveLength(0)
  })

  it('enforces deadlines, cancellation, and bounded in-flight backpressure', async () => {
    const provider = new FakeComputerProvider({ graphicalSessionId: 'session-1' })
      .enqueue({ kind: 'barrier', name: 'blocked' })
      .enqueue({ kind: 'result', result: {} })
    const supervisor = new ProviderSupervisor({
      providerFactory: () => provider,
      graphicalSessionId: 'session-1',
      maxInFlight: 1
    })
    await supervisor.start()
    const blocked = supervisor.dispatch({
      requestId: 'r1',
      operation: 'getAppState',
      input: {},
      deadlineAt: Date.now() + 10_000
    })
    await expect(
      supervisor.dispatch({
        requestId: 'r2',
        operation: 'getAppState',
        input: {},
        deadlineAt: Date.now() + 10_000
      })
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
    await supervisor.cancel('r1')
    provider.release('blocked')
    await expect(blocked).resolves.toMatchObject({ requestId: 'r1' })
  })

  it('rejects provider protocol mismatch with remediation', async () => {
    class MismatchProvider extends FakeComputerProvider {
      override async start() {
        return {
          ...(await super.start()),
          providerProtocol: CONTRACT_VERSIONS.providerProtocol + 1
        }
      }
    }
    const supervisor = new ProviderSupervisor({
      providerFactory: () => new MismatchProvider({ graphicalSessionId: 'session-1' }),
      graphicalSessionId: 'session-1'
    })
    await expect(supervisor.start()).rejects.toMatchObject({
      code: 'version_incompatible',
      remediation: 'upgrade_or_downgrade'
    })
  })

  it('retires and closes a provider generation before a timed-out dispatch returns', async () => {
    class RetiringProvider extends FakeComputerProvider {
      closeCalls = 0

      override async close(): Promise<void> {
        this.closeCalls += 1
        await super.close()
      }
    }
    const timedOut = new RetiringProvider({
      generation: 'provider-1',
      graphicalSessionId: 'session-1'
    }).enqueue({ kind: 'barrier', name: 'blocked' })
    const replacement = new RetiringProvider({
      generation: 'provider-2',
      graphicalSessionId: 'session-1'
    }).enqueue({ kind: 'result', result: {}, dispatched: false })
    const providers = [timedOut, replacement]
    const supervisor = new ProviderSupervisor({
      providerFactory: () => providers.shift()!,
      graphicalSessionId: 'session-1'
    })

    await expect(
      supervisor.dispatch({
        requestId: 'timeout-1',
        operation: 'getAppState',
        input: {},
        deadlineAt: Date.now() + 5
      })
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(timedOut.closeCalls).toBe(1)
    await expect(
      supervisor.dispatch({
        requestId: 'replacement-1',
        operation: 'capabilities',
        input: {},
        deadlineAt: Date.now() + 1_000
      })
    ).resolves.toMatchObject({ requestId: 'replacement-1' })
    expect(supervisor.generation).toBe('provider-2')
  })
})
