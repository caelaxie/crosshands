import { describe, expect, it } from 'vitest'

import {
  CONTRACT_VERSIONS,
  ERROR_CATALOG,
  MutationOutcomeSchema,
  createComputerError,
  negotiateVersionHandshake
} from '../../packages/contract/src/index.js'

describe('outcomes, errors, and protocol negotiation', () => {
  it.each(['verified', 'indeterminate', 'failed', 'not_attempted'])(
    '%s is an honest mutation outcome',
    (state) => {
      expect(MutationOutcomeSchema.safeParse({ state }).success).toBe(true)
    }
  )

  it('publishes stable recovery metadata for every error', () => {
    for (const code of Object.keys(ERROR_CATALOG)) {
      const error = createComputerError(code as keyof typeof ERROR_CATALOG, 'fixture failure')
      expect(error.toJSON()).toMatchObject({
        code,
        message: 'fixture failure',
        retry: expect.any(Boolean),
        remediation: expect.any(String)
      })
    }
  })

  it('accepts the current handshake and rejects incompatibility before dispatch', () => {
    expect(negotiateVersionHandshake(CONTRACT_VERSIONS)).toEqual({
      ok: true,
      versions: CONTRACT_VERSIONS
    })
    expect(
      negotiateVersionHandshake({
        ...CONTRACT_VERSIONS,
        providerProtocol: CONTRACT_VERSIONS.providerProtocol + 1
      })
    ).toMatchObject({ ok: false, error: { code: 'version_incompatible' } })
  })
})
