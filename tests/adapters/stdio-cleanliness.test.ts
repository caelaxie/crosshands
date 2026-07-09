import { existsSync } from 'node:fs'
import { chmod, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, describe, expect, it } from 'vitest'

import { CONTRACT_VERSIONS } from '../../packages/contract/src/index.js'
import { LocalControlServer, brokerEndpoint } from '../../packages/runtime/src/index.js'

const builtEntrypoint = resolve('packages/mcp/dist/bin.js')
const servers: LocalControlServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('CrossHands MCP stdio entrypoint', () => {
  it.runIf(process.platform !== 'win32' && existsSync(builtEntrypoint))(
    'initializes, lists, calls, and closes without stdout corruption or sensitive stderr',
    async () => {
      // Keep the Unix socket below macOS's short sockaddr_un path limit.
      const runtimeDirectory = await mkdtemp('/tmp/chm-')
      await chmod(runtimeDirectory, 0o700)
      const osIdentity = `uid:${process.getuid!()}`
      const graphicalSessionId = `mcp-test-${process.pid}`
      const identity = { osIdentity, graphicalSessionId }
      const calls: unknown[] = []
      const server = new LocalControlServer({
        endpoint: brokerEndpoint({
          platform: process.platform,
          osIdentity,
          graphicalSessionId,
          runtimeDirectory
        }),
        runtimeDirectory,
        tokenFile: join(runtimeDirectory, 'control.token'),
        identity,
        handler: async ({ payload }) => {
          calls.push(payload)
          return {
            requestId: 'stdio-fixture',
            result: { apps: [], applicationText: 'screen-secret-canary' },
            desktopEpoch: 0,
            providerGeneration: 'fixture-provider'
          }
        }
      })
      servers.push(server)
      await server.start()

      const environment = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      )
      Object.assign(environment, {
        CROSSHANDS_RUNTIME_DIR: runtimeDirectory,
        CROSSHANDS_OS_IDENTITY: osIdentity,
        CROSSHANDS_GRAPHICAL_SESSION_ID: graphicalSessionId
      })
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [builtEntrypoint],
        env: environment,
        stderr: 'pipe'
      })
      let diagnostics = ''
      transport.stderr?.on('data', (chunk) => {
        diagnostics += String(chunk)
      })
      const client = new Client(
        { name: 'crosshands-stdio-test', version: CONTRACT_VERSIONS.product },
        { capabilities: {} }
      )

      await client.connect(transport)
      const tools = await client.listTools()
      expect(tools.tools).toHaveLength(14)
      const response = await client.callTool({ name: 'listApps', arguments: {} })
      expect(response.structuredContent).toMatchObject({
        apps: [],
        applicationText: 'screen-secret-canary'
      })
      await client.callTool({
        name: 'typeText',
        arguments: {
          contextToken: `ctx_${'a'.repeat(32)}`,
          target: { kind: 'context-window' },
          text: 'literal-secret-canary'
        }
      })
      await client.close()

      expect(calls).toEqual([
        { operation: 'listApps', input: {} },
        {
          operation: 'typeText',
          input: {
            contextToken: `ctx_${'a'.repeat(32)}`,
            target: { kind: 'context-window' },
            text: 'literal-secret-canary'
          }
        }
      ])
      expect(diagnostics).not.toContain('screen-secret-canary')
      expect(diagnostics).not.toContain('literal-secret-canary')
      expect(diagnostics).not.toContain('Error')
      expect(diagnostics.trim().split('\n')).toEqual([
        '[crosshands-mcp] connected',
        '[crosshands-mcp] closed'
      ])
    },
    15_000
  )
})
