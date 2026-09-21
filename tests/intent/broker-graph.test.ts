import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

const FORBIDDEN = ['@typesafe-ai/sdk', 'api.typesafe.ai', 'liveEvaluator', 'TYPESAFE_API_KEY']

const BROKER_SURFACE = [
  'packages/runtime/src/broker/broker.ts',
  'packages/runtime/src/index.ts',
  'packages/runtime/src/diagnostics/record.ts',
  'packages/runtime/src/diagnostics/writer.ts',
  'packages/cli/src/broker-host.ts',
  'packages/contract/src/errors.ts'
]

describe('broker module graph', () => {
  it('does not mention TypeSafe in runtime, broker-host, or broker diagnostics', async () => {
    const sources = await Promise.all(
      BROKER_SURFACE.map((path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8'))
    )
    for (const [index, path] of BROKER_SURFACE.entries()) {
      const source = sources[index]!
      for (const needle of FORBIDDEN) {
        expect(source, `${path} contains ${needle}`).not.toContain(needle)
      }
    }
  })

  it('does not import intent modules from the broker process', async () => {
    const host = await readFile(
      new URL('../../packages/cli/src/broker-host.ts', import.meta.url),
      'utf8'
    )
    const client = await readFile(
      new URL('../../packages/cli/src/local-client.ts', import.meta.url),
      'utf8'
    )
    expect(host).not.toContain('intent/')
    expect(client).not.toContain('intent/')
  })
})
