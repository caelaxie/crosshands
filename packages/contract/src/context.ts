import { randomBytes } from 'node:crypto'

import { createComputerError } from './errors.js'
import type { InteractionContext, ReferenceBindings, TargetReference } from './schemas.js'

export const DEFAULT_INTERACTION_CONTEXT_TTL_MS = 120_000
export const DEFAULT_INTERACTION_CONTEXT_LIMIT = 32

type InteractionContextStoreOptions = {
  ttlMs?: number
  limit?: number
  now?: () => number
  tokenFactory?: () => string
}

export class InteractionContextStore {
  readonly #ttlMs: number
  readonly #limit: number
  readonly #now: () => number
  readonly #tokenFactory: () => string
  readonly #contexts = new Map<string, InteractionContext>()

  constructor(options: InteractionContextStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_INTERACTION_CONTEXT_TTL_MS
    this.#limit = options.limit ?? DEFAULT_INTERACTION_CONTEXT_LIMIT
    this.#now = options.now ?? Date.now
    this.#tokenFactory =
      options.tokenFactory ?? (() => `ctx_${randomBytes(24).toString('base64url')}`)
    if (this.#ttlMs <= 0 || this.#limit <= 0)
      throw new RangeError('Context TTL and limit must be positive')
  }

  issue(bindings: ReferenceBindings): InteractionContext {
    const issuedAtMs = this.#now()
    const context: InteractionContext = {
      token: this.#tokenFactory(),
      ...bindings,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + this.#ttlMs).toISOString()
    }
    this.#contexts.delete(context.token)
    this.#contexts.set(context.token, context)
    while (this.#contexts.size > this.#limit) {
      const oldest = this.#contexts.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#contexts.delete(oldest)
    }
    return context
  }

  resolve(token: string, now = this.#now()): InteractionContext {
    const context = this.#contexts.get(token)
    if (context === undefined) {
      throw createComputerError(
        'interaction_context_invalid',
        'Interaction context is unknown or forged'
      )
    }
    if (Date.parse(context.expiresAt) < now) {
      this.#contexts.delete(token)
      throw createComputerError('interaction_context_expired', 'Interaction context has expired')
    }
    return context
  }

  invalidateAll(): void {
    this.#contexts.clear()
  }
}

function sameProcess(a: ReferenceBindings['process'], b: ReferenceBindings['process']): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt && a.executableId === b.executableId
}

function sameWindow(a: ReferenceBindings['window'], b: ReferenceBindings['window']): boolean {
  return a.id === b.id && a.ownerPid === b.ownerPid
}

export function assertReferenceFresh(
  reference: TargetReference,
  context: InteractionContext,
  current: ReferenceBindings,
  now = Date.now()
): void {
  const stale =
    reference.contextToken !== context.token ||
    reference.brokerGeneration !== context.brokerGeneration ||
    reference.providerGeneration !== context.providerGeneration ||
    reference.graphicalSessionId !== context.graphicalSessionId ||
    reference.brokerGeneration !== current.brokerGeneration ||
    reference.providerGeneration !== current.providerGeneration ||
    reference.graphicalSessionId !== current.graphicalSessionId ||
    !sameProcess(reference.process, context.process) ||
    !sameProcess(reference.process, current.process) ||
    reference.appId !== context.appId ||
    reference.appId !== current.appId ||
    !sameWindow(reference.window, context.window) ||
    !sameWindow(reference.window, current.window) ||
    reference.snapshotId !== context.snapshotId ||
    reference.snapshotId !== current.snapshotId ||
    reference.desktopEpoch !== context.desktopEpoch ||
    reference.desktopEpoch !== current.desktopEpoch ||
    Date.parse(reference.expiresAt) < now ||
    Date.parse(context.expiresAt) < now

  if (stale) throw createComputerError('stale_target', 'Target reference is no longer fresh')
}
