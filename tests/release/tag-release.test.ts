import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { packages, workspaceRoot } from '../../scripts/package/lib.mjs'
import { npmDistTag, publishOrder } from '../../scripts/package/publish-npm.mjs'

describe('tag GitHub Release and npm publish', () => {
  it('creates a GitHub Release and publishes to public npm on a version tag', async () => {
    const workflow = await readFile(
      join(workspaceRoot, '.github/workflows/tag-release.yml'),
      'utf8'
    )
    expect(workflow).toContain("'v[0-9]+.[0-9]+.[0-9]+'")
    expect(workflow).toContain('gh release create')
    expect(workflow).toContain('registry-url: https://registry.npmjs.org')
    expect(workflow).toContain('node scripts/package/publish-npm.mjs artifacts/packages')
    expect(workflow).toContain('gh release upload')
  })

  it('marks every released package public for the npm org', async () => {
    const manifests = await Promise.all(
      Object.values(packages).map(
        async (pkg) =>
          JSON.parse(
            await readFile(join(workspaceRoot, pkg.directory, 'package.json'), 'utf8')
          ) as {
            publishConfig?: { access?: string }
          }
      )
    )
    for (const manifest of manifests) {
      expect(manifest.publishConfig?.access).toBe('public')
    }
  })

  it('publishes payloads before the main package and uses next for prereleases', () => {
    expect(npmDistTag('0.1.1')).toBe('latest')
    expect(npmDistTag('0.1.1-rc.1')).toBe('next')
    expect(
      publishOrder([
        { name: 'crosshands', version: '0.1.1', archive: 'crosshands.tgz' },
        { name: '@crosshands/mcp', version: '0.1.1', archive: 'mcp.tgz' },
        { name: '@crosshands/contract', version: '0.1.1', archive: 'contract.tgz' }
      ]).map((item) => item.name)
    ).toEqual(['@crosshands/contract', '@crosshands/mcp', 'crosshands'])
    expect(() =>
      publishOrder([{ name: '@crosshands/mcp', version: '0.1.1', archive: 'mcp.tgz' }])
    ).toThrow(/exactly one crosshands archive/)
  })
})
