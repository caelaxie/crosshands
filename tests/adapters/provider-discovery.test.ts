import { describe, expect, it, vi } from 'vitest'

import { loadProviderModule, platformProviderPackage } from '../../packages/cli/src/broker-host.js'
import { CONTRACT_VERSIONS } from '../../packages/contract/src/index.js'

describe('installed platform provider discovery', () => {
  it.each([
    ['darwin', '@crosshands/platform-darwin'],
    ['win32', '@crosshands/platform-windows'],
    ['linux', '@crosshands/platform-linux']
  ] as const)('maps %s to its constrained optional package', (platform, expected) => {
    expect(platformProviderPackage(platform)).toBe(expected)
  })

  it('rejects unsupported hosts before importing arbitrary code', async () => {
    const importer = vi.fn()
    await expect(loadProviderModule('aix', importer)).rejects.toThrow(/no provider package for aix/)
    expect(importer).not.toHaveBeenCalled()
  })

  it('rejects a mismatched payload before provider construction or desktop dispatch', async () => {
    const createProvider = vi.fn()
    await expect(
      loadProviderModule('darwin', async () => ({
        packageVersion: '0.2.0',
        createProvider
      }))
    ).rejects.toThrow(/payload version mismatch/)
    expect(createProvider).not.toHaveBeenCalled()
  })

  it('loads only the exact version-matched platform package', async () => {
    const module = {
      packageVersion: CONTRACT_VERSIONS.product,
      createProvider: vi.fn()
    }
    await expect(loadProviderModule('linux', async () => module)).resolves.toBe(module)
  })
})
