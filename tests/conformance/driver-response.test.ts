import { describe, expect, it } from 'vitest'

import { validateDriverResponse } from '../../benchmarks/conformance/driver-response.mjs'

const catalog = { infrastructureInvalidations: ['host-power-loss'] }
const privacy = {
  rawAccessibilityRetained: false,
  screenshotRetained: false,
  clipboardRetained: false,
  literalInputRetained: false
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'crosshands.conformance-driver-response/v1',
    classification: 'pass',
    automaticRetryCount: 0,
    oracleMatched: true,
    normalizedResultDigest: `sha256:${'a'.repeat(64)}`,
    normalizedErrorCode: null,
    verificationState: 'verified',
    privacy,
    ...overrides
  }
}

describe('conformance driver response boundary', () => {
  it('accepts the minimal privacy-safe pass envelope', () => {
    expect(validateDriverResponse(response(), catalog)).toEqual(response())
  })

  it('rejects raw or unknown evidence fields and self-declared passes without an oracle', () => {
    expect(() => validateDriverResponse(response({ screenshot: 'raw' }), catalog)).toThrow(
      /forbidden field/
    )
    expect(() => validateDriverResponse(response({ oracleMatched: false }), catalog)).toThrow(
      /oracle match/
    )
  })

  it('requires a frozen invalidation and independent evidence digest', () => {
    expect(() =>
      validateDriverResponse(
        response({
          classification: 'infrastructure-invalidated',
          oracleMatched: false,
          infrastructureCode: 'host-power-loss',
          runnerEvidence: `sha256:${'b'.repeat(64)}`
        }),
        catalog
      )
    ).not.toThrow()
    expect(() =>
      validateDriverResponse(
        response({
          classification: 'infrastructure-invalidated',
          oracleMatched: false,
          infrastructureCode: 'host-power-loss',
          runnerEvidence: 'controller-said-so'
        }),
        catalog
      )
    ).toThrow(/evidence digest/)
  })
})
