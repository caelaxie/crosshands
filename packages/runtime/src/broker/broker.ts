import { randomUUID } from 'node:crypto'

import {
  COMPUTER_OPERATIONS,
  InteractionContextStore,
  createComputerError,
  negotiateVersionHandshake,
  type ComputerOperationName,
  type ContractVersions,
  type InteractionContext,
  type ReferenceBindings,
  type TargetReference
} from '@crosshands/contract'

import { assertAppAllowed, type StableAppIdentity } from '../policy/policy.js'
import { ProviderSupervisor } from '../providers/supervisor.js'

export type BrokerPeer = {
  osIdentity: string
  graphicalSessionId: string
  verified: boolean
  local: boolean
}

export type TargetInspection = {
  bindings: ReferenceBindings
  appIdentity: StableAppIdentity
}

export type BrokerRequest = {
  operation: ComputerOperationName
  input: unknown
  deadlineMs?: number
}

export type BrokerResponse = {
  requestId: string
  result: unknown
  desktopEpoch: number
  providerGeneration: string
  context?: InteractionContext
}

export type LocalBrokerOptions = {
  identity: BrokerPeer
  generation?: string
  providerFactory: ConstructorParameters<typeof ProviderSupervisor>[0]['providerFactory']
  inspectTarget?: (
    operation: ComputerOperationName,
    input: unknown
  ) => Promise<TargetInspection | null>
  publish?: (response: BrokerResponse) => Promise<void>
  contextTtlMs?: number
  now?: () => number
}

class SerialQueue {
  #tail: Promise<void> = Promise.resolve()

  async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await work()
    } finally {
      release()
    }
  }
}

function isMutation(operation: ComputerOperationName): boolean {
  return COMPUTER_OPERATIONS[operation].mutation
}

function targetReference(input: unknown): TargetReference | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  const candidate = record.target ?? record.from
  if (candidate === null || typeof candidate !== 'object') return undefined
  const target = candidate as Record<string, unknown>
  if (target.kind === 'element') return target.ref as TargetReference
  if (target.kind === 'coordinate' && target.window !== undefined)
    return target.window as TargetReference
  if ('contextToken' in target) return target as TargetReference
  return undefined
}

function bindReference(
  context: InteractionContext,
  current: ReferenceBindings,
  kind: TargetReference['kind'],
  ref: string
): TargetReference {
  return {
    ...current,
    kind,
    ref,
    contextToken: context.token,
    expiresAt: context.expiresAt
  }
}

function normalizeTarget(
  candidate: unknown,
  context: InteractionContext,
  current: ReferenceBindings
): unknown {
  if (candidate === null || typeof candidate !== 'object') return candidate
  const target = candidate as Record<string, unknown>
  if (target.kind === 'element' && typeof target.elementIndex === 'number') {
    return {
      kind: 'element',
      ref: bindReference(context, current, 'element', `element:${target.elementIndex}`)
    }
  }
  if (target.kind === 'coordinate' && target.window === undefined) {
    return {
      ...target,
      window: bindReference(context, current, 'window', current.window.id)
    }
  }
  if (target.kind === 'context-window') {
    return bindReference(context, current, 'window', current.window.id)
  }
  return candidate
}

function normalizeMutationInput(
  input: unknown,
  context: InteractionContext,
  current: ReferenceBindings
): unknown {
  if (input === null || typeof input !== 'object') return input
  const record = input as Record<string, unknown>
  return {
    ...record,
    ...(record.target === undefined
      ? {}
      : { target: normalizeTarget(record.target, context, current) }),
    ...(record.from === undefined ? {} : { from: normalizeTarget(record.from, context, current) }),
    ...(record.to === undefined ? {} : { to: normalizeTarget(record.to, context, current) })
  }
}

function mutationReferences(input: unknown): TargetReference[] {
  if (input === null || typeof input !== 'object') return []
  const record = input as Record<string, unknown>
  return [record.target, record.from, record.to]
    .map((candidate) => targetReference({ target: candidate }))
    .filter((candidate): candidate is TargetReference => candidate !== undefined)
}

function contextToken(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const token = (input as Record<string, unknown>).contextToken
  return typeof token === 'string' ? token : undefined
}

function computerError(cause: unknown): { code?: string; message: string; toJSON?: () => unknown } {
  if (cause instanceof Error) return cause
  return { message: 'Unknown provider failure' }
}

function assertFreshReference(
  reference: TargetReference,
  context: InteractionContext,
  current: ReferenceBindings,
  now: number
): void {
  const mismatches = [
    [reference.contextToken !== context.token, 'context token'],
    [reference.brokerGeneration !== context.brokerGeneration, 'context broker generation'],
    [reference.providerGeneration !== context.providerGeneration, 'context provider generation'],
    [reference.graphicalSessionId !== context.graphicalSessionId, 'context session'],
    [reference.brokerGeneration !== current.brokerGeneration, 'current broker generation'],
    [reference.providerGeneration !== current.providerGeneration, 'current provider generation'],
    [reference.graphicalSessionId !== current.graphicalSessionId, 'current session'],
    [reference.process.pid !== context.process.pid, 'context pid'],
    [reference.process.startedAt !== context.process.startedAt, 'context process start'],
    [reference.process.executableId !== context.process.executableId, 'context executable'],
    [reference.process.pid !== current.process.pid, 'current pid'],
    [reference.process.startedAt !== current.process.startedAt, 'current process start'],
    [reference.process.executableId !== current.process.executableId, 'current executable'],
    [reference.appId !== context.appId, 'context app'],
    [reference.appId !== current.appId, 'current app'],
    [reference.window.id !== context.window.id, 'context window'],
    [reference.window.ownerPid !== context.window.ownerPid, 'context window owner'],
    [reference.window.id !== current.window.id, 'current window'],
    [reference.window.ownerPid !== current.window.ownerPid, 'current window owner'],
    [reference.snapshotId !== context.snapshotId, 'context snapshot'],
    [reference.snapshotId !== current.snapshotId, 'current snapshot'],
    [reference.desktopEpoch !== context.desktopEpoch, 'context desktop epoch'],
    [reference.desktopEpoch !== current.desktopEpoch, 'current desktop epoch'],
    [Date.parse(reference.expiresAt) < now, 'reference expiration'],
    [Date.parse(context.expiresAt) < now, 'context expiration']
  ]
    .filter(([failed]) => failed)
    .map(([, label]) => label)
  if (mismatches.length > 0) {
    throw createComputerError('stale_target', 'Target reference is no longer fresh', { mismatches })
  }
}

export class BrokerClient {
  constructor(private readonly broker: LocalBroker) {}

  request(request: BrokerRequest): Promise<BrokerResponse> {
    return this.broker.request(request)
  }
}

export class LocalBroker {
  readonly generation: string
  readonly #identity: BrokerPeer
  readonly #supervisor: ProviderSupervisor
  readonly #contexts: InteractionContextStore
  readonly #inspectTarget: LocalBrokerOptions['inspectTarget']
  readonly #publish: LocalBrokerOptions['publish']
  readonly #now: () => number
  readonly #queue = new SerialQueue()
  #desktopEpoch = 0
  #requestSequence = 0

  constructor(options: LocalBrokerOptions) {
    this.generation = options.generation ?? `broker-${randomUUID()}`
    this.#identity = options.identity
    this.#inspectTarget = options.inspectTarget
    this.#publish = options.publish
    this.#now = options.now ?? Date.now
    this.#contexts = new InteractionContextStore({
      ...(options.contextTtlMs === undefined ? {} : { ttlMs: options.contextTtlMs }),
      now: this.#now
    })
    this.#supervisor = new ProviderSupervisor({
      providerFactory: options.providerFactory,
      graphicalSessionId: options.identity.graphicalSessionId
    })
  }

  get desktopEpoch(): number {
    return this.#desktopEpoch
  }

  async connect(handshake: {
    peer: BrokerPeer
    versions: ContractVersions
  }): Promise<BrokerClient> {
    const { peer } = handshake
    if (!peer.verified || !peer.local) {
      throw createComputerError('session_unavailable', 'Broker peer could not be verified locally')
    }
    if (
      peer.osIdentity !== this.#identity.osIdentity ||
      peer.graphicalSessionId !== this.#identity.graphicalSessionId
    ) {
      throw createComputerError(
        'session_unavailable',
        'Broker peer belongs to a different OS identity or graphical session'
      )
    }
    const versions = negotiateVersionHandshake(handshake.versions)
    if (!versions.ok) throw versions.error
    await this.#supervisor.start()
    return new BrokerClient(this)
  }

  issueContext(bindings: ReferenceBindings): InteractionContext {
    return this.#contexts.issue({
      ...bindings,
      brokerGeneration: this.generation,
      providerGeneration: this.#supervisor.generation ?? bindings.providerGeneration,
      graphicalSessionId: this.#identity.graphicalSessionId,
      desktopEpoch: this.#desktopEpoch
    })
  }

  resolveContext(token: string): InteractionContext {
    return this.#contexts.resolve(token)
  }

  request(request: BrokerRequest): Promise<BrokerResponse> {
    return this.#queue.run(() => this.#requestLocked(request))
  }

  async #requestLocked(request: BrokerRequest): Promise<BrokerResponse> {
    const requestId = `broker-${++this.#requestSequence}`
    const deadlineAt = this.#now() + (request.deadlineMs ?? 30_000)
    const mutation = isMutation(request.operation)
    const inspection = await this.#inspectTarget?.(request.operation, request.input)
    if (inspection !== undefined && inspection !== null) assertAppAllowed(inspection.appIdentity)

    let providerInput = request.input
    if (mutation) {
      const token = contextToken(request.input)
      if (token === undefined) {
        throw createComputerError(
          'invalid_argument',
          'Mutation requires a context token and target'
        )
      }
      if (inspection === undefined || inspection === null) {
        throw createComputerError('stale_target', 'Target identity could not be re-resolved')
      }
      const context = this.#contexts.resolve(token)
      providerInput = normalizeMutationInput(request.input, context, inspection.bindings)
      const references = mutationReferences(providerInput)
      if (references.length === 0) {
        throw createComputerError('invalid_argument', 'Mutation requires a target selector')
      }
      for (const reference of references) {
        assertFreshReference(reference, context, inspection.bindings, this.#now())
      }
    }

    try {
      const providerResponse = await this.#supervisor.dispatch({
        requestId,
        operation: request.operation,
        input: providerInput,
        deadlineAt
      })
      if (mutation) {
        const dispatched = providerResponse.dispatched
        if (dispatched) this.#desktopEpoch += 1
        const result =
          'error' in providerResponse
            ? {
                outcome: dispatched
                  ? { state: 'indeterminate', reason: providerResponse.error.message }
                  : { state: 'not_attempted', error: providerResponse.error }
              }
            : providerResponse.result
        const response = {
          requestId,
          result,
          desktopEpoch: this.#desktopEpoch,
          providerGeneration: this.#supervisor.generation ?? 'unknown'
        }
        await this.#publish?.(response)
        return response
      }
      return this.#observationResponse(requestId, providerResponse.result)
    } catch (cause) {
      const error = computerError(cause)
      if (!mutation && error.code === 'provider_crashed') {
        await this.#supervisor.restart()
        this.#contexts.invalidateAll()
        const retry = await this.#supervisor.dispatch({
          requestId: `${requestId}-retry`,
          operation: request.operation,
          input: request.input,
          deadlineAt
        })
        if ('error' in retry) throw Object.assign(new Error(retry.error.message), retry.error)
        return this.#observationResponse(requestId, retry.result)
      }
      if (mutation && (error.code === 'provider_crashed' || error.code === 'timeout')) {
        this.#desktopEpoch += 1
        this.#contexts.invalidateAll()
        const response = {
          requestId,
          result: { outcome: { state: 'indeterminate', reason: error.message } },
          desktopEpoch: this.#desktopEpoch,
          providerGeneration: this.#supervisor.generation ?? 'unknown'
        }
        await this.#publish?.(response)
        return response
      }
      throw cause
    }
  }

  #observationResponse(requestId: string, result: unknown): BrokerResponse {
    let context: InteractionContext | undefined
    if (result !== null && typeof result === 'object' && 'bindings' in result) {
      context = this.issueContext((result as { bindings: ReferenceBindings }).bindings)
    }
    return {
      requestId,
      result,
      desktopEpoch: this.#desktopEpoch,
      providerGeneration: this.#supervisor.generation ?? 'unknown',
      ...(context === undefined ? {} : { context })
    }
  }
}
