#!/usr/bin/env node

import { stdin, stderr, stdout } from 'node:process'
import { StringDecoder } from 'node:string_decoder'

import type { CliIo } from './index.js'

async function readStdin(): Promise<string> {
  const decoder = new StringDecoder('utf8')
  const maximumLength = 1_000_001
  let value = ''
  for await (const chunk of stdin) {
    const decoded = decoder.write(Buffer.from(chunk))
    if (value.length < maximumLength) {
      value += decoded.slice(0, maximumLength - value.length)
    }
  }
  const final = decoder.end()
  if (value.length < maximumLength) value += final.slice(0, maximumLength - value.length)
  return value
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  if (argv[0] === 'broker') {
    const { runBrokerHost } = await import('./broker-host.js')
    await runBrokerHost()
    return 0
  }
  const { runCli } = await import('./index.js')
  const { createProductionBrokerClient } = await import('./local-client.js')
  const io: CliIo = {
    stdin: readStdin,
    stdout: (value) => stdout.write(value),
    stderr: (value) => stderr.write(value)
  }
  const client = await createProductionBrokerClient()
  return runCli(argv, io, client)
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((cause: unknown) => {
    stdout.write(
      `${JSON.stringify({
        error: {
          code: 'provider_unavailable',
          message: cause instanceof Error ? cause.message : 'CrossHands failed to start',
          retry: false,
          remediation: 'run_doctor'
        }
      })}\n`
    )
    process.exitCode = 3
  })
