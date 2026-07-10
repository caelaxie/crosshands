#!/usr/bin/env node

import { dirname, join } from 'node:path'
import { stderr } from 'node:process'
import { fileURLToPath } from 'node:url'

import { createProductionMcpBrokerClient, runMcpStdio, type McpDiagnostic } from './index.js'

function cliEntrypoint(): string {
  const cliIndex = fileURLToPath(import.meta.resolve('crosshands'))
  return join(dirname(cliIndex), 'bin.js')
}

function diagnostic(event: McpDiagnostic): void {
  stderr.write(`[crosshands-mcp] ${event}\n`)
}

async function main(): Promise<void> {
  const client = await createProductionMcpBrokerClient({ entrypoint: cliEntrypoint() })
  await runMcpStdio(client, diagnostic)
}

main().catch(() => {
  diagnostic('startup_failed')
  process.exitCode = 1
})
