import { describe, expect, it } from 'vitest'

import {
  ADAPTER_IDS,
  CONFORMANCE_CATALOG,
  MATRIX_ROLES,
  digest,
  evaluateConformance,
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
  repetitions: 2,
  thresholds: { macos: 2, windows: 2, 'linux-x11': 2 },
  tasks: [CONFORMANCE_CATALOG.tasks[0]!]
}

function manifests(): CandidateManifest[] {
  return MATRIX_ROLES.flatMap((matrixRole) =>
    (['22', '24'] as const).map((nodeVersion) => ({
      schemaVersion: 'crosshands.candidate-manifest/v1' as const,
      candidateId: `${matrixRole}-node${nodeVersion}`,
      releaseCandidateId: 'candidate-1',
      matrixRole,
      platform: rolePlatform[matrixRole],
      osVersion: `${matrixRole}-exact-version`,
      osBuild: `${matrixRole}-exact-build-1`,
      ...(matrixRole === 'windows-11-current-x64'
        ? { matrixAdjudication: 'Windows 11 26H1 selected for the applicable runner hardware' }
        : {}),
      architecture: matrixRole.endsWith('arm64') ? 'arm64' : 'x64',
      nodeVersion,
      desktopSession: 'local-unlocked-session',
      displayLayout: [
        { id: 'primary', origin: { x: 0, y: 0 }, size: { width: 1280, height: 720 }, scale: 1 }
      ],
      locale: 'en-US',
      ime: 'frozen-ime',
      fixtureVersion: catalog.fixtureVersion,
      fixtureResetDigest: digest({ fixture: 'reset' }),
      permissionBaseline: { accessibility: 'granted' },
      runnerImageSha256: '5'.repeat(64),
      runnerBaselineSha256: '6'.repeat(64),
      driverSha256: '8'.repeat(64),
      candidatePackageSetSha256: '7'.repeat(64),
      packageDigests: { crosshands: digest({ package: matrixRole }) },
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
}

function records(candidates: CandidateManifest[]): ConformanceRunRecord[] {
  return candidates.flatMap((manifest) =>
    ADAPTER_IDS.flatMap((adapter) =>
      [1, 2].map((repetition) => ({
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
        durationMs: 5,
        classification: 'pass' as const,
        automaticRetryCount: 0,
        oracleMatched: true,
        normalizedResultDigest: digest({ result: 'same' }),
        normalizedErrorCode: null,
        verificationState: 'observation' as const,
        fixtureResetDigest: manifest.fixtureResetDigest,
        driverSha256: manifest.driverSha256,
        privacy: {
          rawAccessibilityRetained: false as const,
          screenshotRetained: false as const,
          clipboardRetained: false as const,
          literalInputRetained: false as const
        }
      }))
    )
  )
}

describe('conformance evidence evaluator', () => {
  it('accepts only complete per-task, per-adapter, per-cell evidence', () => {
    const candidates = manifests()
    const evaluation = evaluateConformance(candidates, records(candidates), catalog)
    expect(evaluation.accepted).toBe(true)
    expect(evaluation.taskCells).toHaveLength(candidates.length * ADAPTER_IDS.length)
  })

  it('does not hide a product failure in an aggregate score', () => {
    const candidates = manifests()
    const evidence = records(candidates)
    evidence[0] = {
      ...evidence[0]!,
      classification: 'product-failure',
      failureClass: 'assertion',
      oracleMatched: false
    }
    const evaluation = evaluateConformance(candidates, evidence, catalog)
    expect(evaluation.accepted).toBe(false)
    expect(evaluation.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'threshold' })])
    )
    expect(evaluation.taskCells[0]).toMatchObject({ denominator: 2, passed: 1 })
  })

  it('forbids opaque automatic retries in blocking runs', () => {
    const candidates = manifests()
    const evidence = records(candidates)
    evidence[0] = { ...evidence[0]!, automaticRetryCount: 1 }
    const evaluation = evaluateConformance(candidates, evidence, catalog)
    expect(evaluation.accepted).toBe(false)
    expect(evaluation.failures).toContainEqual(expect.objectContaining({ code: 'automatic-retry' }))
  })

  it('rejects records produced by a different conformance driver', () => {
    const candidates = manifests()
    const evidence = records(candidates)
    evidence[0] = { ...evidence[0]!, driverSha256: '9'.repeat(64) }
    const evaluation = evaluateConformance(candidates, evidence, catalog)
    expect(evaluation.accepted).toBe(false)
    expect(evaluation.failures).toContainEqual(expect.objectContaining({ code: 'driver-identity' }))
  })

  it('retains a predeclared infrastructure invalidation and requires a replacement attempt', () => {
    const candidates = manifests()
    const evidence = records(candidates)
    evidence.push({
      ...evidence[0]!,
      runId: 'invalidated-attempt',
      attempt: 2,
      classification: 'infrastructure-invalidated',
      infrastructureCode: 'host-power-loss',
      runnerEvidence: `sha256:${'a'.repeat(64)}`,
      oracleMatched: false
    })
    const evaluation = evaluateConformance(candidates, evidence, catalog)
    expect(evaluation.accepted).toBe(true)
    expect(evaluation.invalidatedAttempts).toBe(1)
  })

  it('rejects unapproved invalidations, adapter divergence, and zero-tolerance failures', () => {
    const candidates = manifests()
    const evidence = records(candidates)
    evidence[0] = {
      ...evidence[0]!,
      classification: 'infrastructure-invalidated',
      infrastructureCode: 'provider-crash',
      runnerEvidence: '',
      oracleMatched: false
    }
    evidence[1] = { ...evidence[1]!, normalizedResultDigest: digest({ divergent: true }) }
    evidence[2] = {
      ...evidence[2]!,
      classification: 'product-failure',
      failureClass: 'secret-leak',
      oracleMatched: false
    }
    const evaluation = evaluateConformance(candidates, evidence, catalog)
    expect(evaluation.accepted).toBe(false)
    expect(evaluation.failures.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'invalid-invalidation',
        'adapter-parity',
        'zero-tolerance',
        'incomplete-repetitions'
      ])
    )
  })
})
