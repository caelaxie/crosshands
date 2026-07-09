import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const PLATFORM_IDS = ['macos', 'windows', 'linux-x11'] as const
export const ADAPTER_IDS = ['broker', 'cli', 'mcp'] as const
export const MATRIX_ROLES = [
  'macos-14-arm64',
  'macos-14-x64',
  'macos-26-arm64',
  'windows-10-x64',
  'windows-11-current-x64',
  'ubuntu-24.04-x64'
] as const

export type PlatformId = (typeof PLATFORM_IDS)[number]
export type AdapterId = (typeof ADAPTER_IDS)[number]
export type MatrixRole = (typeof MATRIX_ROLES)[number]

export interface ConformanceTask {
  id: string
  operations: string[]
  tags: string[]
  oracle: string
}

export interface ConformanceCatalog {
  schemaVersion: 'crosshands.conformance-catalog/v1'
  catalogVersion: string
  fixtureVersion: string
  repetitions: number
  automaticRetries: 'forbidden'
  adapters: AdapterId[]
  thresholds: Record<PlatformId, number>
  infrastructureInvalidations: string[]
  zeroToleranceFailureClasses: string[]
  tasks: ConformanceTask[]
}

export interface CandidateManifest {
  schemaVersion: 'crosshands.candidate-manifest/v1'
  candidateId: string
  releaseCandidateId: string
  matrixRole: MatrixRole
  platform: PlatformId
  osVersion: string
  osBuild: string
  matrixAdjudication?: string
  architecture: string
  nodeVersion: '22' | '24'
  desktopSession: string
  displayLayout: Array<{
    id: string
    origin: { x: number; y: number }
    size: { width: number; height: number }
    scale: number
  }>
  locale: string
  ime: string
  fixtureVersion: string
  fixtureResetDigest: string
  permissionBaseline: Record<string, string>
  runnerImageSha256: string
  runnerBaselineSha256: string
  candidatePackageSetSha256: string
  packageDigests: Record<string, string>
  signerFingerprints: Record<string, string>
  sessionBaseline: {
    active: true
    unlocked: true
    local: true
    competingInputAbsent: true
  }
  exclusions: Array<{ taskId: string; approval: string }>
}

export type FailureClass =
  | 'assertion'
  | 'capability'
  | 'timeout'
  | 'provider-crash'
  | 'adapter-divergence'
  | 'identity-boundary'
  | 'peer-boundary'
  | 'secret-leak'
  | 'payload-integrity'
  | 'silent-success'
  | 'sensitive-target'
  | 'unsigned-artifact'
  | 'mcp-stdout-corruption'
  | 'human-boundary-bypass'
  | 'rollback-failure'

export interface ConformanceRunRecord {
  schemaVersion: 'crosshands.conformance-run/v1'
  runId: string
  candidateId: string
  catalogDigest: string
  fixtureVersion: string
  platform: PlatformId
  cellId: string
  taskId: string
  adapter: AdapterId
  repetition: number
  attempt: number
  startedAt: string
  durationMs: number
  classification: 'pass' | 'product-failure' | 'infrastructure-invalidated'
  failureClass?: FailureClass
  infrastructureCode?: string
  runnerEvidence?: string
  automaticRetryCount: number
  oracleMatched: boolean
  normalizedResultDigest: string
  normalizedErrorCode: string | null
  verificationState: 'verified' | 'indeterminate' | 'failed' | 'not-attempted' | 'observation'
  fixtureResetDigest: string
  privacy: {
    rawAccessibilityRetained: false
    screenshotRetained: false
    clipboardRetained: false
    literalInputRetained: false
  }
}

export interface EvaluationFailure {
  code: string
  message: string
  cellId?: string
  taskId?: string
  adapter?: AdapterId
}

export interface TaskCellResult {
  cellId: string
  taskId: string
  adapter: AdapterId
  passed: number
  denominator: number
  threshold: number
  failureClasses: Record<string, number>
}

export interface ConformanceEvaluation {
  accepted: boolean
  catalogDigest: string
  taskCells: TaskCellResult[]
  invalidatedAttempts: number
  failures: EvaluationFailure[]
}

const catalogUrl = new URL('./catalog.v1.json', import.meta.url)
export const CONFORMANCE_CATALOG = JSON.parse(
  readFileSync(catalogUrl, 'utf8')
) as ConformanceCatalog

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

export const CONFORMANCE_CATALOG_DIGEST = digest(CONFORMANCE_CATALOG)

const ROLE_EXPECTATIONS: Record<MatrixRole, { platform: PlatformId; architecture: string }> = {
  'macos-14-arm64': { platform: 'macos', architecture: 'arm64' },
  'macos-14-x64': { platform: 'macos', architecture: 'x64' },
  'macos-26-arm64': { platform: 'macos', architecture: 'arm64' },
  'windows-10-x64': { platform: 'windows', architecture: 'x64' },
  'windows-11-current-x64': { platform: 'windows', architecture: 'x64' },
  'ubuntu-24.04-x64': { platform: 'linux-x11', architecture: 'x64' }
}

function recordFailure(
  failures: EvaluationFailure[],
  code: string,
  message: string,
  scope: Pick<EvaluationFailure, 'cellId' | 'taskId' | 'adapter'> = {}
): void {
  failures.push({ code, message, ...scope })
}

export function evaluateConformance(
  manifests: CandidateManifest[],
  records: ConformanceRunRecord[],
  catalog: ConformanceCatalog = CONFORMANCE_CATALOG
): ConformanceEvaluation {
  const failures: EvaluationFailure[] = []
  const taskCells: TaskCellResult[] = []
  const catalogDigest = digest(catalog)
  const manifestsByCandidate = new Map(
    manifests.map((manifest) => [manifest.candidateId, manifest])
  )
  const recordsByCandidate = new Map<string, ConformanceRunRecord[]>()
  for (const record of records) {
    const candidateRecords = recordsByCandidate.get(record.candidateId) ?? []
    candidateRecords.push(record)
    recordsByCandidate.set(record.candidateId, candidateRecords)
  }
  if (manifestsByCandidate.size !== manifests.length) {
    recordFailure(failures, 'duplicate-candidate', 'candidate identifiers must be unique')
  }

  for (const manifest of manifests) {
    const expected = ROLE_EXPECTATIONS[manifest.matrixRole]
    if (
      !expected ||
      expected.platform !== manifest.platform ||
      expected.architecture !== manifest.architecture
    ) {
      recordFailure(failures, 'matrix-role', `${manifest.candidateId} contradicts its matrix role`)
    }
    if (manifest.matrixRole === 'windows-11-current-x64' && !manifest.matrixAdjudication?.trim()) {
      recordFailure(
        failures,
        'matrix-adjudication',
        `${manifest.candidateId} does not adjudicate the applicable Windows 11 GA release`
      )
    }
    if (
      /^(latest|current|rolling)$/i.test(manifest.osBuild.trim()) ||
      /replace|placeholder/i.test(manifest.osBuild)
    ) {
      recordFailure(
        failures,
        'moving-os-build',
        `${manifest.candidateId} does not freeze an exact OS build`
      )
    }
    if (manifest.fixtureVersion !== catalog.fixtureVersion) {
      recordFailure(
        failures,
        'fixture-version',
        `${manifest.candidateId} uses a different fixture version`
      )
    }
    if (
      manifest.exclusions.some(({ taskId }) => catalog.tasks.some((task) => task.id === taskId))
    ) {
      recordFailure(
        failures,
        'mandatory-exclusion',
        `${manifest.candidateId} excludes a mandatory task`
      )
    }
    if (
      Object.keys(manifest.packageDigests).length === 0 ||
      Object.keys(manifest.signerFingerprints).length === 0 ||
      !/^[a-f0-9]{64}$/.test(manifest.runnerImageSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.runnerBaselineSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.candidatePackageSetSha256)
    ) {
      recordFailure(
        failures,
        'artifact-identity',
        `${manifest.candidateId} lacks package, signer, or runner identity`
      )
    }
  }

  for (const record of records) {
    const scope = { cellId: record.cellId, taskId: record.taskId, adapter: record.adapter }
    const manifest = manifestsByCandidate.get(record.candidateId)
    if (!manifest) recordFailure(failures, 'unknown-candidate', record.candidateId, scope)
    if (!catalog.tasks.some((task) => task.id === record.taskId)) {
      recordFailure(failures, 'unknown-task', record.taskId, scope)
    }
    if (!catalog.adapters.includes(record.adapter)) {
      recordFailure(failures, 'unknown-adapter', record.adapter, scope)
    }
    if (record.repetition < 1 || record.repetition > catalog.repetitions || record.attempt < 1) {
      recordFailure(failures, 'attempt-identity', record.runId, scope)
    }
    if (record.catalogDigest !== catalogDigest) {
      recordFailure(failures, 'catalog-digest', `${record.runId} used a different catalog`, scope)
    }
    if (record.fixtureVersion !== catalog.fixtureVersion) {
      recordFailure(failures, 'fixture-version', `${record.runId} used a different fixture`, scope)
    }
    if (record.fixtureResetDigest !== manifest?.fixtureResetDigest) {
      recordFailure(
        failures,
        'fixture-reset',
        `${record.runId} did not begin from the frozen oracle`,
        scope
      )
    }
    if (Object.values(record.privacy).some((retained) => retained !== false)) {
      recordFailure(
        failures,
        'privacy-evidence',
        `${record.runId} retained forbidden raw evidence`,
        scope
      )
    }
    if (record.failureClass && catalog.zeroToleranceFailureClasses.includes(record.failureClass)) {
      recordFailure(failures, 'zero-tolerance', `${record.runId}: ${record.failureClass}`, scope)
    }
    if (record.classification === 'pass' && !record.oracleMatched) {
      recordFailure(failures, 'silent-success', `${record.runId} passed without the oracle`, scope)
    }
    if (record.classification === 'product-failure' && !record.failureClass) {
      recordFailure(failures, 'unclassified-product-failure', record.runId, scope)
    }
    if (record.automaticRetryCount !== 0) {
      recordFailure(
        failures,
        'automatic-retry',
        `${record.runId} used ${record.automaticRetryCount} opaque automatic retries`,
        scope
      )
    }
    if (record.classification === 'infrastructure-invalidated') {
      if (
        !record.infrastructureCode ||
        !catalog.infrastructureInvalidations.includes(record.infrastructureCode) ||
        !record.runnerEvidence
      ) {
        recordFailure(
          failures,
          'invalid-invalidation',
          `${record.runId} lacks predeclared independent evidence`,
          scope
        )
      }
    }
  }

  for (const manifest of manifests) {
    const cellRecords = recordsByCandidate.get(manifest.candidateId) ?? []
    const cellIds = [...new Set(cellRecords.map((record) => record.cellId))]
    if (cellIds.length !== 1) {
      recordFailure(
        failures,
        'cell-identity',
        `${manifest.candidateId} must produce exactly one cell identity`
      )
      continue
    }
    const cellId = cellIds[0]
    if (!cellId) continue
    const recordsByTaskAdapter = new Map<string, ConformanceRunRecord[]>()
    const recordsByTaskRepetition = new Map<string, ConformanceRunRecord[]>()
    for (const record of cellRecords) {
      const taskAdapterKey = `${record.taskId}\u0000${record.adapter}`
      const taskAdapterRecords = recordsByTaskAdapter.get(taskAdapterKey) ?? []
      taskAdapterRecords.push(record)
      recordsByTaskAdapter.set(taskAdapterKey, taskAdapterRecords)

      const taskRepetitionKey = `${record.taskId}\u0000${record.repetition}`
      const taskRepetitionRecords = recordsByTaskRepetition.get(taskRepetitionKey) ?? []
      taskRepetitionRecords.push(record)
      recordsByTaskRepetition.set(taskRepetitionKey, taskRepetitionRecords)
    }

    for (const task of catalog.tasks) {
      for (const adapter of catalog.adapters) {
        const scoped = recordsByTaskAdapter.get(`${task.id}\u0000${adapter}`) ?? []
        const eligible = scoped.filter(
          (record) => record.classification !== 'infrastructure-invalidated'
        )
        const byRepetition = new Map<number, ConformanceRunRecord[]>()
        for (const record of eligible) {
          const entries = byRepetition.get(record.repetition) ?? []
          entries.push(record)
          byRepetition.set(record.repetition, entries)
        }
        const duplicate = [...byRepetition.entries()].find(([, entries]) => entries.length !== 1)
        if (duplicate) {
          recordFailure(
            failures,
            'duplicate-terminal-attempt',
            `repetition ${duplicate[0]} has ${duplicate[1].length} terminal attempts`,
            { cellId, taskId: task.id, adapter }
          )
        }
        const expected = new Set(
          Array.from({ length: catalog.repetitions }, (_, index) => index + 1)
        )
        for (const repetition of byRepetition.keys()) expected.delete(repetition)
        if (expected.size > 0 || eligible.length !== catalog.repetitions) {
          recordFailure(
            failures,
            'incomplete-repetitions',
            `expected ${catalog.repetitions} terminal repetitions, received ${eligible.length}`,
            { cellId, taskId: task.id, adapter }
          )
        }
        const passed = eligible.filter((record) => record.classification === 'pass').length
        const threshold = catalog.thresholds[manifest.platform]
        const failureClasses: Record<string, number> = {}
        for (const record of eligible) {
          if (record.classification === 'pass') continue
          const name = record.failureClass ?? 'unclassified'
          failureClasses[name] = (failureClasses[name] ?? 0) + 1
        }
        taskCells.push({
          cellId,
          taskId: task.id,
          adapter,
          passed,
          denominator: eligible.length,
          threshold,
          failureClasses
        })
        if (passed < threshold) {
          recordFailure(
            failures,
            'threshold',
            `${passed}/${eligible.length} is below ${threshold}/${catalog.repetitions}`,
            { cellId, taskId: task.id, adapter }
          )
        }
      }
    }

    for (const task of catalog.tasks) {
      for (let repetition = 1; repetition <= catalog.repetitions; repetition += 1) {
        const taskRepetitionRecords =
          recordsByTaskRepetition.get(`${task.id}\u0000${repetition}`) ?? []
        const comparable = catalog.adapters.flatMap((adapter) =>
          taskRepetitionRecords.filter(
            (record) =>
              record.adapter === adapter && record.classification !== 'infrastructure-invalidated'
          )
        )
        if (comparable.length !== catalog.adapters.length) continue
        const parityKeys = comparable.map((record) =>
          [
            record.normalizedResultDigest,
            record.normalizedErrorCode,
            record.verificationState
          ].join('|')
        )
        if (new Set(parityKeys).size !== 1) {
          recordFailure(failures, 'adapter-parity', `repetition ${repetition} diverged`, {
            cellId,
            taskId: task.id
          })
        }
      }
    }
  }

  for (const matrixRole of MATRIX_ROLES) {
    for (const nodeVersion of ['22', '24'] as const) {
      if (
        !manifests.some(
          (manifest) => manifest.matrixRole === matrixRole && manifest.nodeVersion === nodeVersion
        )
      ) {
        recordFailure(failures, 'missing-matrix-cell', `${matrixRole} Node ${nodeVersion}`)
      }
    }
  }

  return {
    accepted: failures.length === 0,
    catalogDigest,
    taskCells,
    invalidatedAttempts: records.filter(
      (record) => record.classification === 'infrastructure-invalidated'
    ).length,
    failures
  }
}
