import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const SNAPSHOT = '9c8f4c398c3f8ba267cca14e0b65c3f6f87f2aa4'
const PREVIOUS_PIN = '8adfef4ff80e7817b7c7bcd6b8ddf69289078c3c'

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
] as const

describe('orca 9c8f4c3 snapshot ledger', () => {
  it('classifies every inherited operation and ships the snapshot pin', async () => {
    const [ledger, readme] = await Promise.all([
      readFile(new URL('../../docs/compatibility/orca-9c8f4c3.md', import.meta.url), 'utf8'),
      readFile(new URL('../../README.md', import.meta.url), 'utf8')
    ])

    for (const operation of operations) {
      expect(ledger).toContain(`\`${operation}\``)
    }
    expect(ledger).toContain(SNAPSHOT)
    expect(ledger).toContain('All 14 pinned Orca computer-use operations remain represented.')
    expect(readme).toContain(SNAPSHOT)
    expect(readme).not.toContain(PREVIOUS_PIN)
  })

  it('excludes app-only permission status and session ownership', async () => {
    const ledger = await readFile(
      new URL('../../docs/compatibility/orca-9c8f4c3.md', import.meta.url),
      'utf8'
    )

    expect(ledger).toMatch(/`computer\.permissionsStatus`\s+\|\s+excluded/)
    expect(ledger).toMatch(/Agent session ownership\s+\|\s+excluded/)
    expect(ledger).toMatch(/Synthetic \/ modifier-safe click delivery\s+\|\s+adapted/)
    expect(ledger).toContain('`--modifiers`')
    expect(ledger).toMatch(/`--modifiers`\s+\|\s+adapted/)
  })

  it('keeps the machine fixture aligned with the 14 operations', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL('../../packages/contract/test/fixtures/orca-9c8f4c3.json', import.meta.url),
        'utf8'
      )
    ) as {
      commit: string
      pinMoved: boolean
      orcaCommands: string[]
      crosshandsOperations: string[]
      excludedConcepts: string[]
    }

    expect(fixture.commit).toBe(SNAPSHOT)
    expect(fixture.pinMoved).toBe(true)
    expect(fixture.orcaCommands).toHaveLength(14)
    expect(fixture.crosshandsOperations).toHaveLength(14)
    expect(fixture.excludedConcepts).toEqual(
      expect.arrayContaining(['permissionsStatus', 'agentSessionOwnership', 'skillFromExecutable'])
    )
  })
})
