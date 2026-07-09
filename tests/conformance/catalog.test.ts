import { describe, expect, it } from 'vitest'

import { COMPUTER_OPERATIONS } from '../../packages/contract/src/index.js'
import {
  ADAPTER_IDS,
  CONFORMANCE_CATALOG,
  CONFORMANCE_CATALOG_DIGEST,
  MATRIX_ROLES
} from '../../benchmarks/conformance/model.js'

describe('frozen conformance catalog', () => {
  it('pins repetitions, adapter cells, thresholds, and matrix roles', () => {
    expect(CONFORMANCE_CATALOG.repetitions).toBe(100)
    expect(CONFORMANCE_CATALOG.adapters).toEqual(ADAPTER_IDS)
    expect(CONFORMANCE_CATALOG.thresholds).toEqual({
      macos: 95,
      windows: 95,
      'linux-x11': 90
    })
    expect(MATRIX_ROLES).toHaveLength(6)
    expect(CONFORMANCE_CATALOG_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('covers every public operation and required fixture condition', () => {
    const operations = new Set(CONFORMANCE_CATALOG.tasks.flatMap((task) => task.operations))
    expect([...operations].toSorted()).toEqual(Object.keys(COMPUTER_OPERATIONS).toSorted())

    const tags = new Set(CONFORMANCE_CATALOG.tasks.flatMap((task) => task.tags))
    for (const required of [
      'duplicate-names',
      'multiple-windows',
      'invoke',
      'toggle',
      'selection',
      'focus',
      'keys',
      'hotkeys',
      'scroll',
      'drag',
      'secondary-actions',
      'screenshot',
      'secure-fields',
      'rerender',
      'stale-reference',
      'multi-monitor',
      'negative-origin',
      'mixed-scale',
      'minimized',
      'occluded',
      'off-screen',
      'unicode',
      'ime',
      'clipboard',
      'timeout',
      'cancellation',
      'crash',
      'concurrent-client',
      'prompt-injection'
    ]) {
      expect(tags, required).toContain(required)
    }
  })

  it('predeclares narrow infrastructure invalidations and zero-tolerance classes', () => {
    expect(CONFORMANCE_CATALOG.infrastructureInvalidations).not.toContain('test-failure')
    expect(CONFORMANCE_CATALOG.infrastructureInvalidations).not.toContain('provider-crash')
    expect(CONFORMANCE_CATALOG.zeroToleranceFailureClasses).toEqual(
      expect.arrayContaining([
        'silent-success',
        'secret-leak',
        'sensitive-target',
        'payload-integrity',
        'identity-boundary',
        'peer-boundary',
        'mcp-stdout-corruption',
        'human-boundary-bypass'
      ])
    )
  })
})
