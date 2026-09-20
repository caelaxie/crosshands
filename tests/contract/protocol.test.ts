import { describe, expect, it } from 'vitest'

import {
  CONTRACT_VERSIONS,
  ERROR_CATALOG,
  MutationOutcomeSchema,
  ProviderHandshakeSchema,
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

  it('accepts the native macOS helper handshake including helper and supports', () => {
    const parsed = ProviderHandshakeSchema.parse({
      provider: 'crosshands-darwin',
      generation: 'darwin-51a7ddb6-64db-4ad2-9191-98a26a1da284',
      graphicalSessionId: 'aqua-501',
      providerProtocol: 1,
      publicContract: '1.1.0',
      helper: {
        name: 'CrossHands Computer Use',
        bundleId: 'ai.crosshands.ComputerUse'
      },
      capabilities: {
        platform: 'darwin',
        provider: 'crosshands-darwin',
        providerVersion: '1.0.0',
        operations: { click: true, getAppState: true },
        permissions: { accessibility: 'granted', screenshots: 'granted' },
        supports: {
          apps: { list: true },
          windows: { list: true, targetById: true },
          surfaces: { menus: false },
          observation: { screenshot: true, ocr: false },
          actions: { click: true }
        }
      }
    })
    expect(parsed.helper?.bundleId).toBe('ai.crosshands.ComputerUse')
    expect(parsed.capabilities.supports?.observation?.screenshot).toBe(true)
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

  it('rejects a previous public contract after the modifiers schema bump', () => {
    expect(CONTRACT_VERSIONS.publicContract).toBe('1.1.0')
    expect(
      negotiateVersionHandshake({
        ...CONTRACT_VERSIONS,
        publicContract: '1.0.0'
      })
    ).toMatchObject({ ok: false, error: { code: 'version_incompatible' } })
  })
})
