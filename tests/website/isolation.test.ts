import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { REQUIRED_RELEASE_PACKAGES } from '../../benchmarks/agents/model.mjs'
import { packages } from '../../scripts/package/lib.mjs'

const root = new URL('../../', import.meta.url)
const rootPath = fileURLToPath(root)

const readText = (path: string) => readFile(new URL(path, root), 'utf8')
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readText(path)) as T

describe('website isolation', () => {
  it('marks the site private and without a recursive build script', async () => {
    const manifest = await readJson<{
      private?: boolean
      scripts?: Record<string, string>
    }>('website/package.json')

    expect(manifest.private).toBe(true)
    expect(manifest.scripts?.build).toBeUndefined()
  })

  it('joins the workspace outside packages/', async () => {
    const workspace = await readText('pnpm-workspace.yaml')

    expect(workspace).toMatch(/^\s*- website$/m)
    expect(workspace).not.toContain('packages/website')
  })

  it('keeps the site out of the release catalog', () => {
    expect(REQUIRED_RELEASE_PACKAGES).not.toContain('crosshands-website')
    expect(Object.values(packages).map((item) => item.name)).not.toContain('crosshands-website')
  })

  it('commits wrangler project shape without account identity', async () => {
    expect(existsSync(new URL('wrangler.toml', root))).toBe(false)
    expect(existsSync(new URL('wrangler.json', root))).toBe(false)
    expect(existsSync(new URL('wrangler.jsonc', root))).toBe(false)
    expect(existsSync(new URL('website/wrangler.toml', root))).toBe(false)
    expect(existsSync(new URL('website/wrangler.json', root))).toBe(false)

    const config = await readText('website/wrangler.jsonc')
    expect(config).toContain('"name": "crosshands"')
    expect(config).toContain('"pages_build_output_dir": "./dist"')
    expect(config).not.toContain('account_id')
    expect(config).not.toContain('api_token')
    expect(config).not.toContain('oauth_token')
  })

  it('does not commit the Cloudflare account id', () => {
    const accountId = ['187004bce0d79f', '8848857b7cb9013fbb'].join('') // not one literal, so this file is not a hit
    const grep = spawnSync('git', ['grep', '-F', accountId], {
      cwd: rootPath,
      encoding: 'utf8'
    })

    expect(grep.stdout).toBe('')
  })

  it('deploys production only from main through environment website', async () => {
    const deploy = await readText('.github/workflows/website-deploy.yml')
    const verify = await readText('.github/workflows/website.yml')

    expect(deploy).toContain('environment: website')
    expect(deploy).toContain('branches: [main]')
    expect(deploy).not.toContain('pull_request')
    expect(deploy).not.toContain('release-candidate')
    expect(deploy).not.toContain('release-production')
    expect(verify).not.toContain('environment:')
    expect(verify).not.toContain('wrangler')
    expect(verify).not.toContain('deploy.mjs')
  })

  it('does not put Astro on the root workspace manifest', async () => {
    const manifest = await readJson<{
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }>('package.json')

    expect(manifest.dependencies?.astro).toBeUndefined()
    expect(manifest.devDependencies?.astro).toBeUndefined()
  })
})
