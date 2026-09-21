import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { workspaceRoot } from '../../scripts/package/lib.mjs'
import {
  parseProductVersion,
  setProductVersion
} from '../../scripts/package/set-product-version.mjs'

const SITE_PATHS = [
  'packages/cli/package.json',
  'packages/contract/package.json',
  'packages/mcp/package.json',
  'packages/runtime/package.json',
  'packages/provider-testkit/package.json',
  'packages/platform-darwin/package.json',
  'packages/platform-linux/package.json',
  'packages/platform-windows/package.json',
  'packages/contract/schemas/contract.json',
  'packages/platform-linux/assets/payload.json',
  'packages/platform-windows/assets/payload.json',
  'packages/contract/src/versions.ts',
  'integrations/codex/integration.json',
  'integrations/opencode/integration.json',
  'integrations/omp/integration.json',
  'benchmarks/agents/configs/codex-macos.json',
  'benchmarks/agents/configs/opencode-windows.json',
  'benchmarks/agents/configs/omp-ubuntu.json',
  'benchmarks/agents/catalog.json',
  'package.json'
]

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function copyTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'crosshands-set-product-version-'))
  temporaryDirectories.push(root)
  await Promise.all(
    SITE_PATHS.map(async (relativePath) => {
      const destination = join(root, relativePath)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(join(workspaceRoot, relativePath), destination)
    })
  )
  await mkdir(join(root, 'tests/fixtures'), { recursive: true })
  await writeFile(join(root, 'tests/fixtures/example.json'), '{"version":"0.1.0"}\n')
  return root
}

describe('set product version', () => {
  it('rejects v-prefixed and named versions at parseProductVersion', () => {
    expect(parseProductVersion('0.2.0')).toBe('0.2.0')
    expect(() => parseProductVersion('v0.2.0')).toThrow(/Invalid product version: v0\.2\.0/)
    expect(() => parseProductVersion('latest')).toThrow(/Invalid product version: latest/)
  })

  it('rewrites registry files to 0.2.1 and is idempotent', async () => {
    const root = await copyTree()
    const originalCatalog = JSON.parse(
      await readFile(join(root, 'benchmarks/agents/catalog.json'), 'utf8')
    ) as {
      taskCatalogSha256: string
      promptSha256: string
      releasePolicySha256: string
    }
    const result = await setProductVersion({ root, version: '0.2.1' })
    expect(result.version).toBe('0.2.1')
    expect(result.changedPaths).toContain('packages/cli/package.json')
    expect(result.changedPaths).toContain('packages/contract/src/versions.ts')
    expect(result.changedPaths).toContain('benchmarks/agents/configs/codex-macos.json')
    expect(result.changedPaths).toContain('benchmarks/agents/catalog.json')
    expect(result.changedPaths).not.toContain('package.json')

    const cli = JSON.parse(await readFile(join(root, 'packages/cli/package.json'), 'utf8')) as {
      version: string
    }
    expect(cli.version).toBe('0.2.1')
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).toMatchObject({
      version: '0.0.0'
    })

    const versions = await readFile(join(root, 'packages/contract/src/versions.ts'), 'utf8')
    expect(versions).toContain("product: '0.2.1'")
    expect(versions).toContain("publicContract: '1.2.0'")

    const pin = JSON.parse(
      await readFile(join(root, 'integrations/codex/integration.json'), 'utf8')
    ) as { cli: { package: string }; mcp: { package: string } }
    expect(pin.cli.package).toBe('@crosshands/cli@0.2.1')
    expect(pin.mcp.package).toBe('@crosshands/mcp@0.2.1')

    const configPath = join(root, 'benchmarks/agents/configs/codex-macos.json')
    const configBytes = await readFile(configPath)
    const catalog = JSON.parse(
      await readFile(join(root, 'benchmarks/agents/catalog.json'), 'utf8')
    ) as {
      taskCatalogSha256: string
      promptSha256: string
      releasePolicySha256: string
      agents: Array<{ id: string; configSha256: string }>
    }
    const expectedSha256 = createHash('sha256').update(configBytes).digest('hex')
    expect(catalog.agents.find((agent) => agent.id === 'codex')?.configSha256).toBe(expectedSha256)
    expect(catalog.taskCatalogSha256).toBe(originalCatalog.taskCatalogSha256)
    expect(catalog.promptSha256).toBe(originalCatalog.promptSha256)
    expect(catalog.releasePolicySha256).toBe(originalCatalog.releasePolicySha256)
    expect(JSON.parse(configBytes.toString('utf8'))).toMatchObject({
      integration: {
        cliSkill: { package: '@crosshands/cli@0.2.1' },
        mcp: { package: '@crosshands/mcp@0.2.1' }
      }
    })
    expect(await readFile(join(root, 'tests/fixtures/example.json'), 'utf8')).toBe(
      '{"version":"0.1.0"}\n'
    )

    const before = await readFile(join(root, 'packages/cli/package.json'))
    const again = await setProductVersion({ root, version: '0.2.1' })
    expect(again.changedPaths).toEqual([])
    expect(await readFile(join(root, 'packages/cli/package.json'))).toEqual(before)
  })
})
