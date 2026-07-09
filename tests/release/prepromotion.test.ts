import { generateKeyPairSync } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { loadBenchmarkDefinition } from '../../benchmarks/agents/model.mjs'
import {
  validatePrepromotionEvidence,
  verifyPrepromotionSignature
} from '../../benchmarks/agents/validate-prepromotion.mjs'
import { signReleaseManifest, signerFingerprint } from '../../scripts/package/lib.mjs'
import { validReleaseEvidence } from './fixtures/evidence.mjs'

describe('pre-promotion evidence policy', () => {
  it('accepts only the configured signer and exact combined evidence bytes', async () => {
    const definition = await loadBenchmarkDefinition()
    const combined = validReleaseEvidence(definition)
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const signature = signReleaseManifest(combined, privateKey)
    const verify = (overrides: Record<string, unknown> = {}) =>
      verifyPrepromotionSignature({
        combined,
        signature,
        publicKey,
        expectedFingerprint: signerFingerprint(publicKey),
        ...overrides
      })

    expect(verify).not.toThrow()
    expect(() => verify({ combined: { ...combined, version: 'substituted' } })).toThrow(
      /signature is invalid/
    )
    expect(() => verify({ expectedFingerprint: 'sha256:wrong' })).toThrow(/fingerprint changed/)
  })

  it('accepts matching candidate, conformance, and agent evidence', async () => {
    const definition = await loadBenchmarkDefinition()
    const combined = validReleaseEvidence(definition)
    const manifest = { packages: structuredClone(combined.candidate.packages) }
    expect(() =>
      validatePrepromotionEvidence({
        combined,
        conformanceEnvelope: { conformance: combined.conformance },
        agentEnvelope: { agentEvidence: combined.agentEvidence },
        manifest,
        definition,
        version: combined.version,
        manifestSha256: combined.candidate.releaseManifestSha256
      })
    ).not.toThrow()
  })

  it('rejects evidence substitution, threshold drift, and unsigned ownership', async () => {
    const definition = await loadBenchmarkDefinition()
    const combined = validReleaseEvidence(definition)
    const manifest = { packages: structuredClone(combined.candidate.packages) }
    const validate = () =>
      validatePrepromotionEvidence({
        combined,
        conformanceEnvelope: { conformance: combined.conformance },
        agentEnvelope: { agentEvidence: combined.agentEvidence },
        manifest,
        definition,
        version: combined.version,
        manifestSha256: combined.candidate.releaseManifestSha256
      })

    combined.conformance.cells[0]!.tasks[0]!.passed = 0
    combined.conformance.cells[0]!.tasks[0]!.productFailures = 100
    expect(validate).toThrow(/blocking threshold/)

    const unsigned = validReleaseEvidence(definition)
    unsigned.owners[0]!.signature = ''
    expect(() =>
      validatePrepromotionEvidence({
        combined: unsigned,
        conformanceEnvelope: { conformance: unsigned.conformance },
        agentEnvelope: { agentEvidence: unsigned.agentEvidence },
        manifest: { packages: structuredClone(unsigned.candidate.packages) },
        definition,
        version: unsigned.version,
        manifestSha256: unsigned.candidate.releaseManifestSha256
      })
    ).toThrow(/missing signed go decision/)
  })
})
