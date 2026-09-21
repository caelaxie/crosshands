import {
  CONTRACT_VERSIONS,
  COMPUTER_OPERATIONS,
  createComputerError,
  type ComputerProvider,
  type ProviderHandshake,
  type ProviderRequest,
  type ProviderResponse
} from '@crosshands/contract'

export type FakePermissionState = 'granted' | 'denied' | 'unknown' | 'not_required'

export type FakeProviderStep =
  | { kind: 'result'; result: unknown; dispatched?: boolean }
  | {
      kind: 'error'
      code: Parameters<typeof createComputerError>[0]
      message: string
      dispatched?: boolean
    }
  | { kind: 'rerender'; snapshotId: string }
  | { kind: 'identity-swap'; appId: string }
  | { kind: 'permission-change'; permission: string; state: FakePermissionState }
  | { kind: 'session-change'; graphicalSessionId: string }
  | { kind: 'timeout'; dispatched?: boolean }
  | { kind: 'crash'; message: string }
  | { kind: 'barrier'; name: string }

export type FakeProviderState = {
  snapshotId: string
  appId: string
  graphicalSessionId: string
  permissions: Record<string, FakePermissionState>
}

export class FakeComputerProvider implements ComputerProvider {
  readonly generation: string
  readonly calls: ProviderRequest[] = []
  readonly state: FakeProviderState
  readonly #steps: FakeProviderStep[] = []
  readonly #barriers = new Map<string, () => void>()
  #closed = false

  constructor(options: { generation?: string; graphicalSessionId?: string } = {}) {
    this.generation = options.generation ?? 'fake-provider-1'
    this.state = {
      snapshotId: 'snapshot-1',
      appId: 'fixture.app',
      graphicalSessionId: options.graphicalSessionId ?? 'session-1',
      permissions: { accessibility: 'granted', screenshots: 'granted' }
    }
  }

  enqueue(step: FakeProviderStep): this {
    this.#steps.push(step)
    return this
  }

  release(name: string): void {
    const release = this.#barriers.get(name)
    if (release === undefined) throw new Error(`Unknown fake-provider barrier: ${name}`)
    this.#barriers.delete(name)
    release()
  }

  async start(): Promise<ProviderHandshake> {
    this.#closed = false
    return {
      provider: 'crosshands-fake',
      generation: this.generation,
      graphicalSessionId: this.state.graphicalSessionId,
      providerProtocol: CONTRACT_VERSIONS.providerProtocol,
      publicContract: CONTRACT_VERSIONS.publicContract,
      capabilities: {
        platform: 'linux',
        provider: 'crosshands-fake',
        providerVersion: CONTRACT_VERSIONS.product,
        operations: Object.fromEntries(
          Object.keys(COMPUTER_OPERATIONS).map((operation) => [operation, true])
        ),
        permissions: this.state.permissions
      }
    }
  }

  async dispatch(request: ProviderRequest): Promise<ProviderResponse> {
    if (this.#closed) throw new Error('Fake provider is closed')
    this.calls.push(structuredClone(request))

    while (true) {
      const step = this.#steps.shift()
      if (step === undefined) {
        return { requestId: request.requestId, dispatched: false, result: {} }
      }
      switch (step.kind) {
        case 'result':
          return {
            requestId: request.requestId,
            dispatched: step.dispatched ?? true,
            result: structuredClone(step.result)
          }
        case 'error':
          return {
            requestId: request.requestId,
            dispatched: step.dispatched ?? false,
            error: createComputerError(step.code, step.message).toBrokerJSON()
          }
        case 'timeout':
          return {
            requestId: request.requestId,
            dispatched: step.dispatched ?? true,
            error: createComputerError('timeout', 'Fake provider request timed out').toBrokerJSON()
          }
        case 'crash':
          this.#closed = true
          throw new Error(step.message)
        case 'rerender':
          this.state.snapshotId = step.snapshotId
          return {
            requestId: request.requestId,
            dispatched: false,
            result: structuredClone(this.state)
          }
        case 'identity-swap':
          this.state.appId = step.appId
          return {
            requestId: request.requestId,
            dispatched: false,
            result: structuredClone(this.state)
          }
        case 'permission-change':
          this.state.permissions[step.permission] = step.state
          return {
            requestId: request.requestId,
            dispatched: false,
            result: structuredClone(this.state)
          }
        case 'session-change':
          this.state.graphicalSessionId = step.graphicalSessionId
          return {
            requestId: request.requestId,
            dispatched: false,
            result: structuredClone(this.state)
          }
        case 'barrier':
          // oxlint-disable-next-line no-await-in-loop -- a barrier intentionally pauses this request.
          await new Promise<void>((resolve) => this.#barriers.set(step.name, resolve))
          break
      }
    }
  }

  async cancel(_requestId: string): Promise<void> {}

  async close(): Promise<void> {
    this.#closed = true
    for (const release of this.#barriers.values()) release()
    this.#barriers.clear()
  }
}
