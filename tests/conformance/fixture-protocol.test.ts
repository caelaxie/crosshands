import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

const root = new URL('../../fixtures/apps/', import.meta.url)

describe('platform fixture sources', () => {
  it.each([
    ['macOS', 'macos/Sources/CrossHandsConformanceFixture/main.swift'],
    ['Windows', 'windows/MainWindow.xaml'],
    ['Linux', 'linux/crosshands_fixture.py']
  ])('%s exposes common accessibility-visible controls', async (_platform, relativePath) => {
    const source = await readFile(new URL(relativePath, root), 'utf8')
    for (const label of [
      'CrossHands Fixture Invoke',
      'CrossHands Fixture Toggle',
      'CrossHands Fixture Selection',
      'CrossHands Fixture Secure Text',
      'CrossHands Fixture Rerender',
      'SCREENSHOT MARKER 4F7A',
      'UNTRUSTED FIXTURE CONTENT'
    ]) {
      expect(source).toContain(label)
    }
  })

  it('keeps literal and secure values out of the oracle schema', async () => {
    const schema = JSON.parse(await readFile(new URL('oracle.schema.json', root), 'utf8')) as {
      properties: Record<string, unknown>
    }
    for (const forbidden of ['text', 'literalInput', 'clipboard', 'secureValue', 'canary']) {
      expect(schema.properties).not.toHaveProperty(forbidden)
    }
    expect(Object.keys(schema.properties)).toContain('ordinaryTextDigest')
  })
})
