import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

const FORBIDDEN = ['@typesafe-ai/sdk', 'api.typesafe.ai', 'liveEvaluator', 'TYPESAFE_API_KEY']

describe('broker module graph', () => {
  it('does not mention TypeSafe in runtime or broker-host sources', async () => {
    const files = [
      'packages/runtime/src/broker/broker.ts',
      'packages/runtime/src/index.ts',
      'packages/cli/src/broker-host.ts'
    ]
    const sources = await Promise.all(
      files.map((path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8'))
    )
    for (const [index, path] of files.entries()) {
      const source = sources[index]!
      for (const needle of FORBIDDEN) {
        expect(source, `${path} contains ${needle}`).not.toContain(needle)
      }
    }
  })
})
