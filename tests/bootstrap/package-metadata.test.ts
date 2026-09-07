import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), 'utf8')) as T

describe('workspace metadata', () => {
  it('pins the standalone toolchain and supported Node floor', async () => {
    const manifest = await readJson<{
      name: string
      engines: { node: string }
      packageManager: string
      scripts: Record<string, string>
      dependencies: Record<string, string>
    }>('package.json')

    expect(manifest.name).toBe('crosshands-workspace')
    expect(manifest.engines.node).toBe('>=22')
    expect(manifest.packageManager).toMatch(/^pnpm@10\.24\.0/)
    expect(manifest.dependencies.zod).toMatch(/^4\./)
    expect(manifest.scripts).toMatchObject({
      build: expect.any(String),
      lint: expect.any(String),
      typecheck: expect.any(String),
      test: expect.any(String),
      'test:adapters': expect.any(String),
      'test:conformance': expect.any(String)
    })
  })

  it('keeps the required MIT notices', async () => {
    const [license, notices] = await Promise.all([
      readFile(new URL('../../LICENSE', import.meta.url), 'utf8'),
      readFile(new URL('../../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')
    ])

    expect(license).toContain('MIT License')
    expect(notices).toContain('Copyright (c) 2026 Lovecast Inc.')
    expect(notices).toContain('Permission is hereby granted, free of charge')
  })

  it('enumerates every pinned Orca computer-use operation', async () => {
    const ledger = await readFile(
      new URL('../../docs/compatibility/orca-9c8f4c3.md', import.meta.url),
      'utf8'
    )
    const operations = [
      'capabilities',
      'list-apps',
      'permissions',
      'list-windows',
      'get-app-state',
      'click',
      'perform-secondary-action',
      'scroll',
      'drag',
      'type-text',
      'press-key',
      'hotkey',
      'paste-text',
      'set-value'
    ]

    for (const operation of operations) {
      expect(ledger).toContain(`\`${operation}\``)
    }
    expect(ledger).toContain('9c8f4c398c3f8ba267cca14e0b65c3f6f87f2aa4')
    expect(ledger).toContain('All 14 pinned Orca computer-use operations remain represented.')
  })
})
