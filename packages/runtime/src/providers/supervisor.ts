import {
  CONTRACT_VERSIONS,
  ProviderHandshakeSchema,
  createComputerError,
  type ComputerProvider,
  type ProviderHandshake,
  type ProviderRequest,
  type ProviderResponse
} from '@crosshands/contract'

export type ProviderSupervisorOptions = {
  providerFactory: () => ComputerProvider
  graphicalSessionId: string
  maxInFlight?: number
}

export class ProviderSupervisor {
  readonly #providerFactory: () => ComputerProvider
  readonly #graphicalSessionId: string
  readonly #maxInFlight: number
  readonly #inFlight = new Set<string>()
  #provider: ComputerProvider | undefined
  #handshake: ProviderHandshake | undefined
  #retirement: Promise<void> = Promise.resolve()

  constructor(options: ProviderSupervisorOptions) {
    this.#providerFactory = options.providerFactory
    this.#graphicalSessionId = options.graphicalSessionId
    this.#maxInFlight = options.maxInFlight ?? 16
    if (this.#maxInFlight <= 0) throw new RangeError('maxInFlight must be positive')
  }

  get generation(): string | undefined {
    return this.#handshake?.generation
  }

  async start(): Promise<ProviderHandshake> {
    await this.#retirement
    if (this.#handshake !== undefined) return this.#handshake
    const provider = this.#providerFactory()
    let handshake: ProviderHandshake
    try {
      handshake = ProviderHandshakeSchema.parse(await provider.start())
    } catch (cause) {
      await provider.close().catch(() => undefined)
      throw createComputerError('provider_unavailable', 'Provider handshake was malformed', {
        cause: cause instanceof Error ? cause.name : 'unknown'
      })
    }
    if (
      handshake.providerProtocol !== CONTRACT_VERSIONS.providerProtocol ||
      handshake.publicContract !== CONTRACT_VERSIONS.publicContract
    ) {
      await provider.close().catch(() => undefined)
      throw createComputerError('version_incompatible', 'Provider protocol is incompatible', {
        expectedProviderProtocol: CONTRACT_VERSIONS.providerProtocol,
        receivedProviderProtocol: handshake.providerProtocol,
        expectedPublicContract: CONTRACT_VERSIONS.publicContract,
        receivedPublicContract: handshake.publicContract
      })
    }
    if (handshake.graphicalSessionId !== this.#graphicalSessionId) {
      await provider.close().catch(() => undefined)
      throw createComputerError(
        'session_unavailable',
        'Provider is attached to a different graphical session'
      )
    }
    if (handshake.generation !== provider.generation) {
      await provider.close().catch(() => undefined)
      throw createComputerError('provider_unavailable', 'Provider generation handshake mismatch')
    }
    this.#provider = provider
    this.#handshake = handshake
    return handshake
  }

  async dispatch(request: ProviderRequest): Promise<ProviderResponse> {
    const provider = this.#provider ?? (await this.start(), this.#provider)
    if (provider === undefined)
      throw createComputerError('provider_unavailable', 'Provider failed to start')
    if (this.#inFlight.size >= this.#maxInFlight) {
      throw createComputerError('provider_unavailable', 'Provider backpressure limit reached')
    }
    if (request.deadlineAt <= Date.now()) {
      throw createComputerError('timeout', 'Provider request deadline elapsed before dispatch')
    }
    this.#inFlight.add(request.requestId)
    let timer: NodeJS.Timeout | undefined
    let timedOut = false
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          this.#retirement = this.#retire(provider, request.requestId)
          reject(createComputerError('timeout', 'Provider request deadline elapsed'))
        }, request.deadlineAt - Date.now())
        timer.unref()
      })
      return await Promise.race([provider.dispatch(request), timeout])
    } catch (cause) {
      if (timedOut) await this.#retirement
      if (typeof cause === 'object' && cause !== null && 'code' in cause) throw cause
      throw createComputerError('provider_crashed', 'Provider crashed or disconnected', {
        cause: cause instanceof Error ? cause.message : 'unknown'
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.#inFlight.delete(request.requestId)
    }
  }

  async cancel(requestId: string): Promise<void> {
    if (!this.#inFlight.has(requestId)) return
    await this.#provider?.cancel(requestId)
  }

  async restart(): Promise<ProviderHandshake> {
    await this.close()
    return this.start()
  }

  async close(): Promise<void> {
    await this.#retirement
    const provider = this.#provider
    this.#provider = undefined
    this.#handshake = undefined
    this.#inFlight.clear()
    await provider?.close()
  }

  async #retire(provider: ComputerProvider, requestId: string): Promise<void> {
    if (this.#provider === provider) {
      this.#provider = undefined
      this.#handshake = undefined
    }
    await provider.cancel(requestId).catch(() => undefined)
    await provider.close().catch(() => undefined)
  }
}
