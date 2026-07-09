import { describe, expect, it } from 'vitest'

import { aggregateConformance } from '../../benchmarks/conformance/evaluate.mjs'
import {
  ADAPTER_IDS,
  CONFORMANCE_CATALOG,
  MATRIX_ROLES,
  digest,
  type CandidateManifest,
  type ConformanceCatalog,
  type ConformanceRunRecord,
  type MatrixRole,
  type PlatformId
} from '../../benchmarks/conformance/model.js'

const rolePlatform: Record<MatrixRole, PlatformId> = {
  'macos-14-arm64': 'macos',
  'macos-14-x64': 'macos',
  'macos-26-arm64': 'macos',
  'windows-10-x64': 'windows',
  'windows-11-current-x64': 'windows',
  'ubuntu-24.04-x64': 'linux-x11'
}

const catalog: ConformanceCatalog = {
  ...CONFORMANCE_CATALOG,
  repetitions: 3,
  thresholds: { macos: 2, windows: 2, 'linux-x11': 2 },
  tasks: [CONFORMANCE_CATALOG.tasks[0]!]
}

function evidence(): { manifests: CandidateManifest[]; records: ConformanceRunRecord[] } {
  const manifests = MATRIX_ROLES.flatMap((matrixRole) =>
    (['22', '24'] as const).map((nodeVersion) => ({
      schemaVersion: 'crosshands.candidate-manifest/v1' as const,
      candidateId: `${matrixRole}-node${nodeVersion}`,
      releaseCandidateId: 'crosshands-0.1.0-rc.1',
      matrixRole,
      platform: rolePlatform[matrixRole],
      osVersion: `${matrixRole}-version`,
      osBuild: `${matrixRole}-build-123`,
      ...(matrixRole === 'windows-11-current-x64'
        ? { matrixAdjudication: 'Windows 11 26H1 selected for the applicable runner hardware' }
        : {}),
      architecture: matrixRole.endsWith('arm64') ? 'arm64' : 'x64',
      nodeVersion,
      desktopSession: `${matrixRole}-desktop`,
      displayLayout: [
        { id: 'primary', origin: { x: 0, y: 0 }, size: { width: 1440, height: 900 }, scale: 2 },
        { id: 'left', origin: { x: -1920, y: 0 }, size: { width: 1920, height: 1080 }, scale: 1 }
      ],
      locale: 'en-US',
      ime: 'frozen-ime',
      fixtureVersion: catalog.fixtureVersion,
      fixtureResetDigest: digest({ reset: matrixRole }),
      permissionBaseline: { accessibility: 'granted' },
      runnerImageSha256: '5'.repeat(64),
      runnerBaselineSha256: '6'.repeat(64),
      candidatePackageSetSha256: '7'.repeat(64),
      packageDigests: { crosshands: digest({ candidate: 1 }) },
      signerFingerprints: { crosshands: 'fixture-signer' },
      sessionBaseline: {
        active: true as const,
        unlocked: true as const,
        local: true as const,
        competingInputAbsent: true as const
      },
      exclusions: []
    }))
  )
  const records = manifests.flatMap((manifest) =>
    ADAPTER_IDS.flatMap((adapter) =>
      [1, 2, 3].map((repetition) => ({
        schemaVersion: 'crosshands.conformance-run/v1' as const,
        runId: `${manifest.candidateId}:${adapter}:${repetition}`,
        candidateId: manifest.candidateId,
        catalogDigest: digest(catalog),
        fixtureVersion: catalog.fixtureVersion,
        platform: manifest.platform,
        cellId: `${manifest.candidateId}:cell`,
        taskId: catalog.tasks[0]!.id,
        adapter,
        repetition,
        attempt: 1,
        startedAt: '2026-07-10T00:00:00.000Z',
        durationMs: 1,
        classification: 'pass' as const,
        automaticRetryCount: 0,
        oracleMatched: true,
        normalizedResultDigest: digest({ result: 'same' }),
        normalizedErrorCode: null,
        verificationState: 'observation' as const,
        fixtureResetDigest: manifest.fixtureResetDigest,
        privacy: {
          rawAccessibilityRetained: false as const,
          screenshotRetained: false as const,
          clipboardRetained: false as const,
          literalInputRetained: false as const
        }
      }))
    )
  )
  return { manifests, records }
}

describe('release-facing conformance aggregate', () => {
  it('emits six policy cells with conservative task and Node gate results', () => {
    const { manifests, records } = evidence()
    const weak = records.find(
      (record) =>
        record.candidateId === 'windows-11-current-x64-node24' &&
        record.adapter === 'mcp' &&
        record.repetition === 3
    )!
    Object.assign(weak, {
      classification: 'product-failure',
      failureClass: 'assertion',
      oracleMatched: false
    })
    records.push({
      ...records[0]!,
      runId: 'retained-infrastructure-attempt',
      attempt: 2,
      classification: 'infrastructure-invalidated',
      infrastructureCode: 'host-power-loss',
      runnerEvidence: 'controller-event-1',
      oracleMatched: false
    })

    const aggregate = aggregateConformance(manifests, records, catalog)
    expect(aggregate.conformance.cells).toHaveLength(6)
    const windows = aggregate.conformance.cells.find(
      ({ id }: { id: string }) => id === 'windows11-current-x64'
    )!
    expect(windows.nodeGates).toEqual([
      { node: '22', package: true, cli: true, mcp: true },
      { node: '24', package: true, cli: true, mcp: true }
    ])
    expect(windows.tasks[0]).toMatchObject({
      denominator: 3,
      passed: 2,
      productFailures: 1,
      automaticRetries: 0
    })
    expect(aggregate.conformance.cells[0]!.tasks[0]).toMatchObject({
      infrastructureFailures: 1
    })
    expect(aggregate.conformance.cells[0]!.invalidatedRuns).toHaveLength(1)
    expect(Array.isArray(aggregate.conformance.cells[0]!.invalidatedRuns)).toBe(true)
    expect(windows.matrixAdjudication).toContain('26H1')
    expect(windows.exclusions).toEqual([])
    expect(windows.tasks[0]!.recordsSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('keeps the production artifact bound to all 28 frozen task IDs', () => {
    expect(CONFORMANCE_CATALOG.tasks).toHaveLength(28)
    expect(new Set(CONFORMANCE_CATALOG.tasks.map(({ id }) => id)).size).toBe(28)
  })
})
