import { describe, expect, it } from 'vitest'

import { loadBenchmarkDefinition, validateReleaseEvidence } from '../../benchmarks/agents/model.mjs'
import { validReleaseEvidence } from './fixtures/evidence.mjs'

describe('release evidence model', () => {
  it('accepts a complete immutable evidence fixture', async () => {
    const definition = await loadBenchmarkDefinition()
    expect(() =>
      validateReleaseEvidence(validReleaseEvidence(definition), definition)
    ).not.toThrow()
  })

  it('rejects package promotion drift, missing provenance, and unsigned ownership', async () => {
    const definition = await loadBenchmarkDefinition()
    const drift = validReleaseEvidence(definition)
    drift.defaultChannel.packages.find((item) => item.name === 'crosshands')!.sha256 = 'a'.repeat(
      64
    )
    expect(() => validateReleaseEvidence(drift, definition)).toThrow(
      /does not match the frozen value/
    )

    const missingSbom = validReleaseEvidence(definition) as Record<string, unknown>
    delete missingSbom.sbom
    expect(() => validateReleaseEvidence(missingSbom, definition)).toThrow(/must be an object/)

    const missingNotice = validReleaseEvidence(definition)
    missingNotice.legalNotices.pop()
    expect(() => validateReleaseEvidence(missingNotice, definition)).toThrow(/must contain exactly/)

    const unsignedOwner = validReleaseEvidence(definition)
    unsignedOwner.owners[0]!.signature = ''
    expect(() => validateReleaseEvidence(unsignedOwner, definition)).toThrow(/must be a string/)
  })

  it('applies every conformance threshold per task, never as an aggregate', async () => {
    const definition = await loadBenchmarkDefinition()
    const evidence = validReleaseEvidence(definition)
    const task = evidence.conformance.cells
      .find((cell) => cell.id === 'windows11-current-x64')!
      .tasks.find((result) => result.taskId === 'act.drag')!
    task.passed = 94
    task.productFailures = 6
    expect(() => validateReleaseEvidence(evidence, definition)).toThrow(/below 95\/100/)
  })

  it('requires every exact task from the cryptographically bound conformance catalog', async () => {
    const definition = await loadBenchmarkDefinition()
    const evidence = validReleaseEvidence(definition)
    expect(evidence.conformance.catalogVersion).toBe(definition.conformanceCatalog.catalogVersion)
    expect(evidence.conformance.cells[0]!.tasks).toHaveLength(28)
    evidence.conformance.cells[0]!.tasks.pop()
    expect(() => validateReleaseEvidence(evidence, definition)).toThrow(/must contain exactly/)
  })

  it('rejects every zero-tolerance violation regardless of benchmark totals', async () => {
    const definition = await loadBenchmarkDefinition()
    const evidence = validReleaseEvidence(definition)
    const caseRecord = evidence.zeroTolerance.find((record) => record.case === 'silent-success')!
    caseRecord.violations = 1
    caseRecord.passed = false
    expect(() => validateReleaseEvidence(evidence, definition)).toThrow(/violations/)
  })

  it('requires rollback proof and all 0/1/6/24-hour platform canaries', async () => {
    const definition = await loadBenchmarkDefinition()
    const rollback = validReleaseEvidence(definition)
    rollback.rollback.sameDigestPromotion = false
    expect(() => validateReleaseEvidence(rollback, definition)).toThrow(/sameDigestPromotion/)

    const canary = validReleaseEvidence(definition)
    canary.canaries = canary.canaries.filter(
      (record) => !(record.hour === 24 && record.platform === 'win32')
    )
    expect(() => validateReleaseEvidence(canary, definition)).toThrow(/must contain exactly/)
  })

  it('rejects an unpinned agent model, approval, network, or config snapshot', async () => {
    const definition = await loadBenchmarkDefinition()
    for (const field of ['model', 'approvalMode', 'network', 'configSha256'] as const) {
      const evidence = validReleaseEvidence(definition)
      const config = evidence.agentEvidence.configs[0]!
      if (field === 'network')
        config.network = { ...config.network, packageRegistryDuringRun: true }
      else config[field] = 'changed'
      expect(() => validateReleaseEvidence(evidence, definition)).toThrow(/frozen value/)
    }
  })
})
