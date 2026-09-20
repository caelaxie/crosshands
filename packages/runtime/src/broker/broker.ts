import { randomUUID } from 'node:crypto'

import {
  InteractionContextStore,
  createComputerError,
  negotiateVersionHandshake,
  parseOperationOutput,
  type ComputerOperationName,
  type ContractVersions,
  type InteractionContext,
  type ReferenceBindings,
  type TargetReference
} from '@crosshands/contract'

import {
  DIAGNOSTIC_RECORD_VERSION,
  diagnosticError,
  diagnosticPlatform,
  diagnosticRequestResult,
  diagnosticTarget,
  isMutationOperation,
  type DiagnosticRecord,
  type DiagnosticsSink
} from '../diagnostics/record.js'
import { graphicalSessionKey } from '../diagnostics/paths.js'
import { JsonlDiagnosticsWriter } from '../diagnostics/writer.js'
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
  diagnostics?: DiagnosticsSink
  diagnosticsDirectory?: string
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
  return isMutationOperation(operation)
}

function assertedInputApp(input: unknown): void {
  if (input === null || typeof input !== 'object') return
  const app = (input as { app?: unknown }).app
  if (typeof app === 'string' && app.length > 0) {
    assertAppAllowed({ appId: app, executableId: app })
  }
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
  readonly #session: string
  readonly #supervisor: ProviderSupervisor
  readonly #contexts: InteractionContextStore
  readonly #inspectTarget: LocalBrokerOptions['inspectTarget']
  readonly #publish: LocalBrokerOptions['publish']
  readonly #diagnostics: DiagnosticsSink | undefined
  readonly #now: () => number
  readonly #queue = new SerialQueue()
  #desktopEpoch = 0
  #requestSequence = 0
  #closed = false

  constructor(options: LocalBrokerOptions) {
    this.generation = options.generation ?? `broker-${randomUUID()}`
    this.#identity = options.identity
    this.#session = graphicalSessionKey(options.identity.graphicalSessionId)
    this.#inspectTarget = options.inspectTarget
    this.#publish = options.publish
    this.#now = options.now ?? Date.now
    this.#diagnostics =
      options.diagnostics ??
      (options.diagnosticsDirectory === undefined
        ? undefined
        : new JsonlDiagnosticsWriter({
            directory: options.diagnosticsDirectory,
            generation: this.generation
          }))
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
    this.#emit({ kind: 'helper.start', ...this.#envelope() })
    return new BrokerClient(this)
  }

  markListening(): void {
    this.#emit({ kind: 'broker.start', ...this.#envelope() })
  }

  noteHandshake(event: { accepted: boolean; requestId: string; code?: string }): void {
    this.#emit({
      kind: 'client.handshake',
      ...this.#envelope(),
      accepted: event.accepted,
      requestId: event.requestId,
      ...(event.code === undefined ? {} : { code: event.code })
    })
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#supervisor.close()
    this.#emit({ kind: 'broker.stop', reason: 'signal', ...this.#envelope() })
    await this.#diagnostics?.close()
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
    const enqueuedAt = this.#now()
    return this.#queue.run(() => this.#requestLocked(request, enqueuedAt))
  }

  async #requestLocked(request: BrokerRequest, enqueuedAt: number): Promise<BrokerResponse> {
    const startedAt = this.#now()
    const requestId = `broker-${++this.#requestSequence}`
    const deadlineAt = this.#now() + (request.deadlineMs ?? 30_000)
    const mutation = isMutation(request.operation)
    let inspectMs = 0
    let dispatchMs = 0
    let bindings: ReferenceBindings | undefined
    let dispatched: boolean | undefined
    assertedInputApp(request.input)
    let context: InteractionContext | undefined
    let inspectionInput = request.input
    try {
      if (mutation) {
        const token = contextToken(request.input)
        if (token === undefined) {
          throw createComputerError(
            'invalid_argument',
            'Mutation requires a context token and target'
          )
        }
        context = this.#contexts.resolve(token)
        // Context-window and index shorthand do not carry an identity until the
        // broker binds them. Inspect the bound form so native providers can
        // re-resolve the exact process/window before dispatch.
        inspectionInput = normalizeMutationInput(request.input, context, context)
      }
      const inspectStarted = this.#now()
      const inspection = await this.#inspectTarget?.(request.operation, inspectionInput)
      inspectMs = this.#now() - inspectStarted
      if (inspection !== undefined && inspection !== null) {
        assertAppAllowed(inspection.appIdentity)
        bindings = inspection.bindings
      }

      let providerInput = request.input
      if (mutation) {
        if (inspection === undefined || inspection === null) {
          throw createComputerError('stale_target', 'Target identity could not be re-resolved')
        }
        providerInput = normalizeMutationInput(request.input, context!, inspection.bindings)
        const references = mutationReferences(providerInput)
        if (references.length === 0) {
          throw createComputerError('invalid_argument', 'Mutation requires a target selector')
        }
        for (const reference of references) {
          assertFreshReference(reference, context!, inspection.bindings, this.#now())
        }
      }

      const dispatchStarted = this.#now()
      const providerResponse = await this.#supervisor.dispatch({
        requestId,
        operation: request.operation,
        input: providerInput,
        deadlineAt
      })
      dispatchMs = this.#now() - dispatchStarted
      dispatched = providerResponse.dispatched
      if (mutation) {
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
          result: this.#publicResult(request.operation, result),
          desktopEpoch: this.#desktopEpoch,
          providerGeneration: this.#supervisor.generation ?? 'unknown'
        }
        this.#emitRequest(
          request,
          requestId,
          enqueuedAt,
          startedAt,
          inspectMs,
          dispatchMs,
          bindings,
          dispatched,
          response.result
        )
        await this.#publish?.(response)
        return response
      }
      const response = this.#observationResponse(
        requestId,
        request.operation,
        providerResponse.result
      )
      this.#emitRequest(
        request,
        requestId,
        enqueuedAt,
        startedAt,
        inspectMs,
        dispatchMs,
        bindings,
        dispatched,
        response.result
      )
      return response
    } catch (cause) {
      const error = computerError(cause)
      if (!mutation && error.code === 'provider_crashed') {
        this.#emit({
          kind: 'helper.crash',
          ...this.#envelope(),
          requestId,
          operation: request.operation,
          error: diagnosticError(cause)
        })
        const previousGeneration = this.#supervisor.generation
        await this.#supervisor.restart()
        this.#contexts.invalidateAll()
        this.#emit({
          kind: 'helper.restart',
          ...this.#envelope(),
          ...(previousGeneration === undefined ? {} : { previousGeneration })
        })
        const retryStarted = this.#now()
        const retry = await this.#supervisor.dispatch({
          requestId: `${requestId}-retry`,
          operation: request.operation,
          input: request.input,
          deadlineAt
        })
        dispatchMs += this.#now() - retryStarted
        if ('error' in retry) {
          const failure = Object.assign(new Error(retry.error.message), retry.error)
          this.#emitRequest(
            request,
            requestId,
            enqueuedAt,
            startedAt,
            inspectMs,
            dispatchMs,
            bindings,
            retry.dispatched,
            undefined,
            failure
          )
          throw failure
        }
        const response = this.#observationResponse(requestId, request.operation, retry.result)
        this.#emitRequest(
          request,
          requestId,
          enqueuedAt,
          startedAt,
          inspectMs,
          dispatchMs,
          bindings,
          retry.dispatched,
          response.result
        )
        return response
      }
      if (mutation && (error.code === 'provider_crashed' || error.code === 'timeout')) {
        if (error.code === 'provider_crashed') {
          this.#emit({
            kind: 'helper.crash',
            ...this.#envelope(),
            requestId,
            operation: request.operation,
            error: diagnosticError(cause)
          })
        }
        this.#desktopEpoch += 1
        this.#contexts.invalidateAll()
        const response = {
          requestId,
          result: this.#publicResult(request.operation, {
            outcome: { state: 'indeterminate', reason: error.message }
          }),
          desktopEpoch: this.#desktopEpoch,
          providerGeneration: this.#supervisor.generation ?? 'unknown'
        }
        this.#emitRequest(
          request,
          requestId,
          enqueuedAt,
          startedAt,
          inspectMs,
          dispatchMs,
          bindings,
          true,
          response.result
        )
        await this.#publish?.(response)
        return response
      }
      this.#emitRequest(
        request,
        requestId,
        enqueuedAt,
        startedAt,
        inspectMs,
        dispatchMs,
        bindings,
        dispatched,
        undefined,
        cause
      )
      throw cause
    }
  }

  #observationResponse(
    requestId: string,
    operation: ComputerOperationName,
    result: unknown
  ): BrokerResponse {
    let context: InteractionContext | undefined
    const publicResult = this.#publicResult(operation, result)
    if (publicResult !== null && typeof publicResult === 'object' && 'context' in publicResult)
      context = (publicResult as { context: InteractionContext }).context
    return {
      requestId,
      result: publicResult,
      desktopEpoch: this.#desktopEpoch,
      providerGeneration: this.#supervisor.generation ?? 'unknown',
      ...(context === undefined ? {} : { context })
    }
  }

  #publicResult(operation: ComputerOperationName, result: unknown): unknown {
    if (result === null || typeof result !== 'object')
      return parseOperationOutput(operation, result)
    const value = result as Record<string, unknown>
    let publicResult: Record<string, unknown> = value
    if ('bindings' in value) {
      const { bindings, ...snapshot } = value
      publicResult = { ...snapshot, context: this.issueContext(bindings as ReferenceBindings) }
    } else if (
      value.freshState !== null &&
      typeof value.freshState === 'object' &&
      'bindings' in value.freshState
    ) {
      const { bindings, ...freshState } = value.freshState as Record<string, unknown>
      publicResult = {
        ...value,
        freshState: {
          ...freshState,
          context: this.issueContext(bindings as ReferenceBindings)
        }
      }
    }
    return parseOperationOutput(operation, publicResult)
  }

  #envelope(): {
    v: typeof DIAGNOSTIC_RECORD_VERSION
    ts: string
    session: string
    brokerGeneration: string
    providerGeneration?: string
    desktopEpoch: number
    platform: ReturnType<typeof diagnosticPlatform>
  } {
    return {
      v: DIAGNOSTIC_RECORD_VERSION,
      ts: new Date(this.#now()).toISOString(),
      session: this.#session,
      brokerGeneration: this.generation,
      ...(this.#supervisor.generation === undefined
        ? {}
        : { providerGeneration: this.#supervisor.generation }),
      desktopEpoch: this.#desktopEpoch,
      platform: diagnosticPlatform()
    }
  }

  #emit(record: DiagnosticRecord): void {
    try {
      this.#diagnostics?.emit(record)
    } catch {
      // Diagnostics must not fail computer-use.
    }
  }

  #emitRequest(
    request: BrokerRequest,
    requestId: string,
    enqueuedAt: number,
    startedAt: number,
    inspectMs: number,
    dispatchMs: number,
    bindings: ReferenceBindings | undefined,
    dispatched: boolean | undefined,
    result: unknown,
    cause?: unknown
  ): void {
    const target = diagnosticTarget(request.input, bindings)
    this.#emit({
      kind: 'request',
      ...this.#envelope(),
      requestId,
      operation: request.operation,
      mutation: isMutation(request.operation),
      ms: {
        queue: Math.max(0, startedAt - enqueuedAt),
        inspect: inspectMs,
        dispatch: dispatchMs,
        total: Math.max(0, this.#now() - enqueuedAt)
      },
      ...(target === undefined ? {} : { target }),
      result:
        cause !== undefined
          ? { type: 'error', ...diagnosticError(cause) }
          : diagnosticRequestResult(request.operation, result, dispatched)
    })
  }
}
