#!/usr/bin/env node

import { stdin, stderr, stdout } from 'node:process'

import { runBrokerHost } from './broker-host.js'
import { runCli, type CliIo } from './index.js'
import { createProductionBrokerClient } from './local-client.js'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  if (argv[0] === 'broker') {
    await runBrokerHost()
    return 0
  }
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
