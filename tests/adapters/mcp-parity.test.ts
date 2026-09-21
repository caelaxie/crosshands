import { readFile } from 'node:fs/promises'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'

import { COMPUTER_OPERATIONS, CONTRACT_VERSIONS } from '../../packages/contract/src/index.js'
import {
  MCP_TOOL_CATALOG,
  callMcpTool,
  createMcpServer,
  type CliBrokerClient
} from '../../packages/mcp/src/index.js'

function broker(result: unknown = { ok: true }): {
  client: CliBrokerClient
  calls: Array<{ operation: string; input: unknown }>
} {
  const calls: Array<{ operation: string; input: unknown }> = []
  return {
    calls,
    client: {
      request: async (operation, input) => {
        calls.push({ operation, input })
        return result
      },
      close: async () => undefined
    }
  }
}

async function connectedMcp(state: ReturnType<typeof broker>): Promise<{
  client: Client
  close(): Promise<void>
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(state.client)
  const client = new Client({ name: 'crosshands-test', version: '0.1.0' }, { capabilities: {} })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

describe('CrossHands MCP adapter', () => {
  const contextToken = `ctx_${'a'.repeat(32)}`
  const operationVectors: Array<[keyof typeof COMPUTER_OPERATIONS, Record<string, unknown>]> = [
    ['capabilities', {}],
    ['permissions', { id: 'accessibility' }],
    ['listApps', {}],
    ['listWindows', { app: 'fixture.app' }],
    ['getAppState', { app: 'fixture.app', window: { index: 0 } }],
    ['click', { contextToken, target: { kind: 'element', elementIndex: 1 } }],
    [
      'click',
      {
        contextToken,
        target: { kind: 'element', elementIndex: 1 },
        modifiers: ['Shift', 'CmdOrCtrl']
      }
    ],
    [
      'performSecondaryAction',
      { contextToken, target: { kind: 'element', elementIndex: 1 }, action: 'showMenu' }
    ],
    ['scroll', { contextToken, target: { kind: 'coordinate', x: 10, y: 20 }, direction: 'down' }],
    [
      'drag',
      {
        contextToken,
        from: { kind: 'coordinate', x: 10, y: 20 },
        to: { kind: 'coordinate', x: 30, y: 40 }
      }
    ],
    ['typeText', { contextToken, target: { kind: 'context-window' }, text: 'hello' }],
    ['pressKey', { contextToken, target: { kind: 'context-window' }, key: 'Return' }],
    ['hotkey', { contextToken, target: { kind: 'context-window' }, keys: ['CmdOrCtrl', 'P'] }],
    ['pasteText', { contextToken, target: { kind: 'context-window' }, text: 'hello' }],
    ['setValue', { contextToken, target: { kind: 'element', elementIndex: 2 }, value: 'hello' }]
  ]

  it('derives exactly one tool for every shared computer operation', () => {
    expect(Object.keys(MCP_TOOL_CATALOG)).toEqual(Object.keys(COMPUTER_OPERATIONS))
    expect(Object.keys(MCP_TOOL_CATALOG)).toHaveLength(14)
  })

  it('exposes click modifiers on the derived click tool', () => {
    const schema = MCP_TOOL_CATALOG.click.inputSchema as {
      properties?: Record<string, unknown>
    }
    expect(schema.properties).toHaveProperty('modifiers')
    expect(MCP_TOOL_CATALOG.click.metadata['crosshands.publicContractVersion']).toBe('1.2.0')
    expect(MCP_TOOL_CATALOG).not.toHaveProperty('doctor')
  })

  it('initializes and lists all operation-derived typed tools with instructions', async () => {
    const state = broker()
    const mcp = await connectedMcp(state)
    try {
      const listed = await mcp.client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toEqual(Object.keys(COMPUTER_OPERATIONS))
      expect(listed.tools).toHaveLength(14)
      for (const tool of listed.tools) {
        const expected = MCP_TOOL_CATALOG[tool.name as keyof typeof MCP_TOOL_CATALOG]
        expect(tool.description).toBe(expected.description)
        expect(tool.annotations).toEqual(expected.annotations)
        expect(tool.inputSchema).toMatchObject({ type: 'object' })
        expect(tool['_meta']).toEqual(expected.metadata)
        expect(tool.execution).toEqual({ taskSupport: 'forbidden' })
      }
      expect(mcp.client.getServerCapabilities()).toEqual({ tools: { listChanged: true } })
      expect(mcp.client.getInstructions()).toContain('untrusted content')
      expect(mcp.client.getInstructions()).toContain('CLI stdin')
    } finally {
      await mcp.close()
    }
  })

  it('unwraps a BrokerResponse envelope before returning structured content', async () => {
    const inner = { apps: [{ id: 'fixture', name: 'Fixture' }] }
    const state = broker({
      requestId: 'broker-1',
      result: inner,
      desktopEpoch: 0,
      providerGeneration: 'provider-1'
    })
    await expect(callMcpTool(state.client, 'listApps', {})).resolves.toEqual(inner)
  })

  it('returns structured content plus text JSON fallback through the server', async () => {
    const result = { apps: [{ id: 'fixture', name: 'Fixture' }] }
    const state = broker(result)
    const mcp = await connectedMcp(state)
    try {
      const response = await mcp.client.callTool({ name: 'listApps', arguments: {} })
      expect(response.structuredContent).toEqual(result)
      expect(response.content).toEqual([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining(JSON.stringify(result))
        })
      ])
      expect(JSON.stringify(response.content)).toContain('UNTRUSTED APPLICATION CONTENT')
      expect(state.calls).toEqual([{ operation: 'listApps', input: {} }])
    } finally {
      await mcp.close()
    }
  })

  it('rejects malformed and protected server calls before broker dispatch', async () => {
    const state = broker()
    const mcp = await connectedMcp(state)
    try {
      const invalid = await mcp.client.callTool({ name: 'listWindows', arguments: {} })
      expect(invalid.isError).toBe(true)
      expect(state.calls).toEqual([])

      const protectedResult = await mcp.client.callTool({
        name: 'typeText',
        arguments: {
          contextToken: `ctx_${'a'.repeat(32)}`,
          target: { kind: 'context-window' },
          text: 'canary',
          protectedInput: true
        }
      })
      expect(protectedResult).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: 'invalid_argument', remediation: 'use_cli_stdin' }
        }
      })
      expect(state.calls).toEqual([])
    } finally {
      await mcp.close()
    }
  })

  it('validates input before dispatch and preserves normalized operation input', async () => {
    const state = broker()
    await expect(callMcpTool(state.client, 'listWindows', {})).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(state.calls).toEqual([])

    await callMcpTool(state.client, 'listWindows', { app: 'fixture.app' })
    expect(state.calls).toEqual([{ operation: 'listWindows', input: { app: 'fixture.app' } }])
  })

  it.each(operationVectors)(
    'dispatches the shared %s operation without remapping',
    async (operation, input) => {
      const result = { fixtureOperation: operation }
      const state = broker(result)
      await expect(callMcpTool(state.client, operation, input)).resolves.toEqual(result)
      expect(state.calls).toEqual([{ operation, input }])
    }
  )

  it.each(['typeText', 'pasteText', 'setValue'] as const)(
    'rejects protected literal input for %s before broker dispatch',
    async (operation) => {
      const state = broker()
      const input = {
        contextToken: `ctx_${'a'.repeat(32)}`,
        target: { kind: 'context-window' },
        ...(operation === 'setValue' ? { value: 'canary' } : { text: 'canary' }),
        protectedInput: true
      }
      await expect(callMcpTool(state.client, operation, input)).rejects.toMatchObject({
        code: 'invalid_argument',
        remediation: 'use_cli_stdin'
      })
      expect(state.calls).toEqual([])
    }
  )

  it('marks observations read-only and mutations destructive and open-world', () => {
    for (const [name, operation] of Object.entries(COMPUTER_OPERATIONS)) {
      expect(MCP_TOOL_CATALOG[name as keyof typeof MCP_TOOL_CATALOG].annotations).toEqual(
        operation.mutation
          ? { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
          : { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
      )
    }
  })

  it('preserves broker result and CrossHands errors', async () => {
    const result = { outcome: { state: 'indeterminate', reason: 'verification unavailable' } }
    const success = broker(result)
    await expect(
      callMcpTool(success.client, 'click', {
        contextToken: `ctx_${'a'.repeat(32)}`,
        target: { kind: 'coordinate', x: 1, y: 2 }
      })
    ).resolves.toEqual(result)

    const failure = broker()
    failure.client.request = async () => {
      throw Object.assign(new Error('permission required'), {
        code: 'permission_denied',
        retry: false,
        remediation: 'grant_permission'
      })
    }
    await expect(
      callMcpTool(failure.client, 'getAppState', { app: 'fixture.app' })
    ).rejects.toMatchObject({
      code: 'permission_denied',
      remediation: 'grant_permission'
    })
  })

  it('returns broker errors with CrossHands semantics through MCP tool results', async () => {
    const state = broker()
    state.client.request = async () => {
      throw Object.assign(new Error('permission required'), {
        code: 'permission_denied',
        retry: false,
        remediation: 'grant_permission'
      })
    }
    const mcp = await connectedMcp(state)
    try {
      const response = await mcp.client.callTool({
        name: 'getAppState',
        arguments: { app: 'fixture.app' }
      })
      expect(response).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: 'permission_denied',
            message: 'permission required',
            retry: false,
            remediation: 'grant_permission'
          }
        }
      })
      expect(JSON.stringify(response.content)).toContain('permission_denied')
    } finally {
      await mcp.close()
    }
  })

  it.each(['codex', 'opencode', 'omp'])(
    'pins CLI skill and MCP stdio package configuration for %s',
    async (clientName) => {
      const fixture = JSON.parse(
        await readFile(
          new URL(`../../integrations/${clientName}/integration.json`, import.meta.url),
          'utf8'
        )
      ) as Record<string, Record<string, unknown> | string>
      expect(fixture).toMatchObject({
        client: clientName,
        cli: {
          package: `@crosshands/cli@${CONTRACT_VERSIONS.product}`,
          command: 'crosshands',
          skill: '../../skills/crosshands-computer-use/SKILL.md'
        },
        mcp: {
          package: `@crosshands/mcp@${CONTRACT_VERSIONS.product}`,
          transport: 'stdio',
          command: 'crosshands-mcp',
          args: []
        }
      })
    }
  )

  it('exposes no experimental resource, prompt, task, HTTP, or SSE surfaces', () => {
    for (const tool of Object.values(MCP_TOOL_CATALOG)) {
      expect(tool).not.toHaveProperty('execution')
      expect(tool).not.toHaveProperty('transport')
      expect(tool.description.toLowerCase()).toContain('untrusted')
    }
  })
})
