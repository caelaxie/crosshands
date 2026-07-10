export type BundleArtifact = {
  name: string
  version: string
  expectedDigest: string
  actualDigest: string
  trustVerified: boolean
}

export type BundleCandidate = {
  version: string
  release: number
  manifestDigest: string
  requiredArtifacts: readonly string[]
  artifacts: readonly BundleArtifact[]
}

export type LifecyclePhase =
  | 'idle'
  | 'running'
  | 'draining'
  | 'activating'
  | 'uninstalling'
  | 'uninstalled'

export type LifecycleErrorCode =
  | 'bundle_incomplete'
  | 'bundle_integrity'
  | 'bundle_version_mismatch'
  | 'lifecycle_busy'
  | 'mutation_rejected'
  | 'version_incompatible'

export class BundleLifecycleError extends Error {
  constructor(
    readonly code: LifecycleErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'BundleLifecycleError'
  }
}

export type ActivationHooks = {
  /** Runs before the atomic active-version pointer changes. */
  beforeCommit?: () => void | Promise<void>
  /** Runs after the pointer changes, to model restart/interruption after commit. */
  afterCommit?: () => void | Promise<void>
}

export type ClientState = {
  id: string
  version: string
  reconnectRequired: boolean
}

export type DispatchVersions = {
  client: string
  broker: string
  provider: string
  payload: string
}

export type InteractionContextGeneration = {
  generation: number
}

export type InstalledResourceKind =
  | 'broker-registration'
  | 'ipc'
  | 'cache'
  | 'log'
  | 'temporary-capture'
  | 'export'
  | 'configuration'
  | 'permission'

export type InstalledResource = {
  id: string
  kind: InstalledResourceKind
  owner: 'crosshands' | 'user' | 'os'
}

export type UninstallPlan = {
  remove: readonly InstalledResource[]
  preserve: readonly InstalledResource[]
  manual: readonly InstalledResource[]
}

const REMOVABLE_CROSSHANDS_RESOURCES = new Set<InstalledResourceKind>([
  'broker-registration',
  'ipc',
  'cache',
  'log',
  'temporary-capture'
])

export function planUninstall(resources: readonly InstalledResource[]): UninstallPlan {
  const remove: InstalledResource[] = []
  const preserve: InstalledResource[] = []
  const manual: InstalledResource[] = []

  for (const resource of resources) {
    if (resource.kind === 'permission') {
      manual.push(resource)
    } else if (
      resource.owner === 'crosshands' &&
      REMOVABLE_CROSSHANDS_RESOURCES.has(resource.kind)
    ) {
      remove.push(resource)
    } else {
      preserve.push(resource)
    }
  }

  return { remove, preserve, manual }
}

function validateCandidate(candidate: BundleCandidate): BundleCandidate {
  if (
    candidate.version.length === 0 ||
    !Number.isSafeInteger(candidate.release) ||
    candidate.release < 0
  ) {
    throw new BundleLifecycleError('bundle_version_mismatch', 'Bundle version is invalid')
  }
  if (candidate.manifestDigest.length === 0) {
    throw new BundleLifecycleError('bundle_integrity', 'Bundle manifest digest is missing')
  }

  const required = new Set(candidate.requiredArtifacts)
  const artifacts = new Map<string, BundleArtifact>()
  if (required.size !== candidate.requiredArtifacts.length) {
    throw new BundleLifecycleError('bundle_incomplete', 'Required artifact names must be unique')
  }
  for (const artifact of candidate.artifacts) {
    if (artifacts.has(artifact.name)) {
      throw new BundleLifecycleError('bundle_incomplete', 'Bundle artifact names must be unique')
    }
    if (artifact.version !== candidate.version) {
      throw new BundleLifecycleError(
        'bundle_version_mismatch',
        `Artifact ${artifact.name} does not match bundle ${candidate.version}`
      )
    }
    if (
      artifact.expectedDigest.length === 0 ||
      artifact.actualDigest !== artifact.expectedDigest ||
      !artifact.trustVerified
    ) {
      throw new BundleLifecycleError(
        'bundle_integrity',
        `Artifact ${artifact.name} failed integrity verification`
      )
    }
    artifacts.set(artifact.name, artifact)
  }
  const missing = [...required].filter((name) => !artifacts.has(name))
  if (missing.length > 0) {
    throw new BundleLifecycleError(
      'bundle_incomplete',
      `Bundle is missing required artifacts: ${missing.join(', ')}`
    )
  }

  return Object.freeze({
    ...candidate,
    requiredArtifacts: Object.freeze([...candidate.requiredArtifacts]),
    artifacts: Object.freeze(candidate.artifacts.map((artifact) => Object.freeze({ ...artifact })))
  })
}

/**
 * Coordinates installed bundle state. Filesystem/package-manager work is deliberately
 * supplied by callers; this class owns only verification gates and atomic state changes.
 */
export class BundleLifecycle {
  readonly #bundles = new Map<string, BundleCandidate>()
  readonly #clients = new Map<string, ClientState>()
  readonly #drainWaiters = new Set<() => void>()
  #phase: LifecyclePhase = 'idle'
  #activeVersion: string | undefined
  #mutationCount = 0
  #contextGeneration = 0

  get phase(): LifecyclePhase {
    return this.#phase
  }

  get activeVersion(): string | undefined {
    return this.#activeVersion
  }

  get inFlightMutations(): number {
    return this.#mutationCount
  }

  stage(candidate: BundleCandidate): void {
    this.#assertNotBusy()
    const verified = validateCandidate(candidate)
    const existing = this.#bundles.get(verified.version)
    if (existing !== undefined && existing.manifestDigest !== verified.manifestDigest) {
      throw new BundleLifecycleError(
        'bundle_integrity',
        `Version ${verified.version} is already staged with a different manifest`
      )
    }
    this.#bundles.set(verified.version, verified)
    if (this.#phase === 'uninstalled') this.#phase = 'idle'
  }

  bundle(version: string): BundleCandidate | undefined {
    return this.#bundles.get(version)
  }

  beginMutation(): () => void {
    if (this.#phase !== 'running' || this.#activeVersion === undefined) {
      throw new BundleLifecycleError(
        'mutation_rejected',
        `Mutations are unavailable while lifecycle is ${this.#phase}`
      )
    }
    this.#mutationCount += 1
    let completed = false
    return () => {
      if (completed) return
      completed = true
      this.#mutationCount -= 1
      if (this.#mutationCount === 0) {
        for (const resolve of this.#drainWaiters) resolve()
        this.#drainWaiters.clear()
      }
    }
  }

  async activate(version: string, hooks: ActivationHooks = {}): Promise<void> {
    this.#assertNotBusy()
    const target = this.#requireBundle(version)
    this.#assertAdjacentToActive(target)
    this.#phase = 'draining'
    await this.#waitForMutations()

    try {
      await hooks.beforeCommit?.()
      this.#phase = 'activating'

      // This synchronous assignment is the state-machine commit point. Callers map it
      // to an atomic pointer/rename and must not mutate a bundle in place.
      this.#activeVersion = target.version
      this.#contextGeneration += 1
      for (const [id, client] of this.#clients) {
        this.#clients.set(id, { ...client, reconnectRequired: true })
      }

      await hooks.afterCommit?.()
    } finally {
      this.#phase = this.#activeVersion === undefined ? 'idle' : 'running'
    }
  }

  async rollback(version: string, hooks: ActivationHooks = {}): Promise<void> {
    await this.activate(version, hooks)
  }

  connectClient(id: string, version: string): ClientState {
    this.#assertClientCompatible(version)
    const client = { id, version, reconnectRequired: false }
    this.#clients.set(id, client)
    return { ...client }
  }

  reconnectClient(id: string, version: string): ClientState {
    if (!this.#clients.has(id)) {
      throw new BundleLifecycleError('version_incompatible', `Client ${id} is not connected`)
    }
    return this.connectClient(id, version)
  }

  client(id: string): ClientState | undefined {
    const client = this.#clients.get(id)
    return client === undefined ? undefined : { ...client }
  }

  assertDispatchCompatible(versions: DispatchVersions): void {
    const active = this.#requireActive()
    for (const [role, version] of [
      ['broker', versions.broker],
      ['provider', versions.provider],
      ['payload', versions.payload]
    ] as const) {
      if (version !== active.version) {
        throw new BundleLifecycleError(
          'version_incompatible',
          `${role} ${version} must match active bundle ${active.version}`
        )
      }
    }
    this.#assertClientCompatible(versions.client)
  }

  issueContext(): InteractionContextGeneration {
    this.#requireActive()
    return { generation: this.#contextGeneration }
  }

  isContextCurrent(context: InteractionContextGeneration): boolean {
    return this.#activeVersion !== undefined && context.generation === this.#contextGeneration
  }

  async uninstall(
    resources: readonly InstalledResource[],
    remove: (resource: InstalledResource) => void | Promise<void>
  ): Promise<UninstallPlan> {
    this.#assertNotBusy()
    const plan = planUninstall(resources)
    this.#phase = 'draining'
    await this.#waitForMutations()
    this.#phase = 'uninstalling'

    try {
      await Promise.all(plan.remove.map((resource) => remove(resource)))
    } catch (error) {
      this.#phase = this.#activeVersion === undefined ? 'idle' : 'running'
      throw error
    }

    this.#bundles.clear()
    this.#clients.clear()
    this.#activeVersion = undefined
    this.#contextGeneration += 1
    this.#phase = 'uninstalled'
    return plan
  }

  #assertNotBusy(): void {
    if (
      this.#phase === 'draining' ||
      this.#phase === 'activating' ||
      this.#phase === 'uninstalling'
    ) {
      throw new BundleLifecycleError('lifecycle_busy', `Lifecycle is already ${this.#phase}`)
    }
  }

  #requireBundle(version: string): BundleCandidate {
    const bundle = this.#bundles.get(version)
    if (bundle === undefined) {
      throw new BundleLifecycleError('bundle_incomplete', `Bundle ${version} is not staged`)
    }
    return bundle
  }

  #requireActive(): BundleCandidate {
    if (this.#activeVersion === undefined) {
      throw new BundleLifecycleError('bundle_incomplete', 'No bundle is active')
    }
    return this.#requireBundle(this.#activeVersion)
  }

  #assertAdjacentToActive(target: BundleCandidate): void {
    if (this.#activeVersion === undefined) return
    const active = this.#requireActive()
    if (Math.abs(target.release - active.release) > 1) {
      throw new BundleLifecycleError(
        'version_incompatible',
        `Bundle ${target.version} is outside the one-release compatibility window of ${active.version}`
      )
    }
  }

  #assertClientCompatible(version: string): void {
    const active = this.#requireActive()
    const client = this.#requireBundle(version)
    if (Math.abs(client.release - active.release) > 1) {
      throw new BundleLifecycleError(
        'version_incompatible',
        `Client ${version} is outside the one-release compatibility window of ${active.version}`
      )
    }
  }

  async #waitForMutations(): Promise<void> {
    if (this.#mutationCount === 0) return
    await new Promise<void>((resolve) => this.#drainWaiters.add(resolve))
  }
}
