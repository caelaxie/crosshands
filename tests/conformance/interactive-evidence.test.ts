import { describe, expect, it } from 'vitest'

import { loadConformanceEvidence } from '../../benchmarks/conformance/evaluate.mjs'
import { evaluateConformance } from '../../benchmarks/conformance/model.js'

const evidenceRoot = process.env.CROSSHANDS_CONFORMANCE_EVIDENCE

describe.runIf(Boolean(evidenceRoot))('interactive conformance release evidence', () => {
  it('contains a complete accepted mandatory matrix', async () => {
    const root = evidenceRoot!
    const { manifests, records } = await loadConformanceEvidence(root)

    const evaluation = evaluateConformance(manifests, records)
    expect(evaluation, JSON.stringify(evaluation.failures, null, 2)).toMatchObject({
      accepted: true,
      failures: []
    })
  })
})
