#!/usr/bin/env node
// MCP adapter smoke test for the repo-built CrossHands MCP server.
// Spawns packages/mcp/dist/bin.js over stdio, performs the MCP handshake,
// lists the tool catalog, calls `capabilities`, and proves the protectedInput
// rejection never reaches the broker. Exit 0 on success, 1 on any mismatch.
//
// Usage (from the repo root, with the verification env already exported):
//   node .cursor/skills/verify-crosshands/helpers/mcp-smoke.mjs <evidence-dir>
//
// Writes <evidence-dir>/mcp-smoke.json with the full transcript summary.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const evidenceDir = process.argv[2]
if (evidenceDir === undefined) {
  console.error('usage: mcp-smoke.mjs <evidence-dir>')
  process.exit(1)
}
mkdirSync(evidenceDir, { recursive: true })

const EXPECTED_TOOLS = [
  'capabilities',
  'permissions',
  'listApps',
  'listWindows',
  'getAppState',
  'click',
  'performSecondaryAction',
  'scroll',
  'drag',
  'typeText',
  'pressKey',
  'hotkey',
  'pasteText',
  'setValue'
]

const child = spawn(process.execPath, ['packages/mcp/dist/bin.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env
})
let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += chunk
})

let buffer = ''
const pending = new Map()
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line.length === 0) continue
    const message = JSON.parse(line)
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
})

let sequence = 0
function request(method, params) {
  const id = ++sequence
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000)
  })
}

function check(condition, label, detail) {
  if (!condition) throw new Error(`check failed: ${label} (${JSON.stringify(detail)})`)
  return { label, ok: true }
}

const checks = []
try {
  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'verify-crosshands', version: '0.0.0' }
  })
  checks.push(
    check(
      initialized.result?.serverInfo?.name === 'CrossHands',
      'initialize returns serverInfo.name CrossHands',
      initialized.result?.serverInfo
    )
  )

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  const toolList = await request('tools/list', {})
  const names = (toolList.result?.tools ?? []).map((tool) => tool.name).sort()
  checks.push(
    check(
      JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort()),
      'tools/list exposes exactly the 14 contract operations',
      names
    )
  )

  const capabilities = await request('tools/call', { name: 'capabilities', arguments: {} })
  checks.push(
    check(
      capabilities.result?.isError !== true &&
        capabilities.result?.structuredContent?.platform === process.platform,
      'tools/call capabilities reaches the provider through the broker',
      capabilities.result?.structuredContent ?? capabilities.result
    )
  )

  const protectedCall = await request('tools/call', {
    name: 'typeText',
    arguments: {
      contextToken: 'ctx_' + 'a'.repeat(32),
      target: { kind: 'context-window' },
      text: 'canary',
      protectedInput: true
    }
  })
  const protectedError = protectedCall.result?.structuredContent?.error
  checks.push(
    check(
      protectedCall.result?.isError === true &&
        protectedError?.code === 'invalid_argument' &&
        protectedError?.remediation === 'use_cli_stdin',
      'protectedInput=true is rejected before broker dispatch',
      protectedCall.result?.structuredContent
    )
  )

  const summary = {
    ok: true,
    checks,
    toolCount: names.length,
    capabilities: capabilities.result?.structuredContent ?? null,
    protectedInputRejection: protectedError ?? null,
    serverStderr: stderr.trim()
  }
  writeFileSync(join(evidenceDir, 'mcp-smoke.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify({ ok: true, checks: checks.length, toolCount: names.length }))
} catch (cause) {
  const summary = {
    ok: false,
    checks,
    failure: cause instanceof Error ? cause.message : String(cause),
    serverStderr: stderr.trim()
  }
  writeFileSync(join(evidenceDir, 'mcp-smoke.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify({ ok: false, failure: summary.failure }))
  process.exitCode = 1
} finally {
  child.kill('SIGTERM')
}
