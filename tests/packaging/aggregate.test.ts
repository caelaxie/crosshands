import { describe, expect, it } from 'vitest'

import { validateRunnerManifests } from '../../scripts/package/aggregate.mjs'
import { packageManagerInvocation } from '../../scripts/package/lib.mjs'

const common = ['@crosshands/contract', '@crosshands/runtime', 'crosshands', '@crosshands/mcp']

function sources() {
  return [
    ['darwin', '@crosshands/platform-darwin'],
    ['win32', '@crosshands/platform-windows'],
    ['linux', '@crosshands/platform-linux']
  ].map(([platform, payload]) => ({
    platform,
    manifest: {
      version: '0.1.0',
      contractVersion: '1.0.0',
      controlProtocol: 1,
      providerProtocol: 1,
      mcpProtocol: '2025-11-25',
      packages: [
        ...common.map((name) => ({ name, sha256: `${name}-immutable` })),
        { name: payload, sha256: `${payload}-immutable` }
      ]
    }
  }))
}

describe('cross-platform no-rebuild aggregation', () => {
  it('routes Windows package-manager shims through cmd without a shell string', () => {
    expect(packageManagerInvocation('corepack', ['pnpm', 'build'], 'win32')).toMatchObject({
      args: ['/d', '/c', 'call', 'corepack.cmd', 'pnpm', 'build']
    })
    expect(packageManagerInvocation('corepack', ['pnpm', 'build'], 'linux')).toEqual({
      command: 'corepack',
      args: ['pnpm', 'build']
    })
  })

  it('accepts exactly matched common packages and all three payloads', () => {
    expect(() => validateRunnerManifests(sources())).not.toThrow()
  })

  it('rejects a rebuilt common package even when versions match', () => {
    const candidates = sources()
    candidates[1]!.manifest.packages[0]!.sha256 = 'rebuilt-on-windows'
    expect(() => validateRunnerManifests(candidates)).toThrow(/digests disagree/)
  })

  it('rejects missing platforms and version-domain disagreement', () => {
    expect(() => validateRunnerManifests(sources().slice(0, 2))).toThrow(/linux runner/)
    const candidates = sources()
    candidates[2]!.manifest.providerProtocol = 2
    expect(() => validateRunnerManifests(candidates)).toThrow(/providerProtocol/)
  })
})
