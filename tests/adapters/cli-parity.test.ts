import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CONTRACT_VERSIONS } from '../../packages/contract/src/index.js'
import {
  createProductionBrokerClient,
  localClientPaths,
  runCli,
  type CliBrokerClient,
  type CliIo,
  type LocalClientPaths
} from '../../packages/cli/src/index.js'
import { FakeComputerProvider } from '../../packages/provider-testkit/src/index.js'
import {
  LocalBroker,
  LocalControlServer,
  type BrokerPeer
} from '../../packages/runtime/src/index.js'

function harness(result: unknown = { ok: true }): {
  io: CliIo
  client: CliBrokerClient
  calls: Array<{ operation: string; input: unknown }>
  stdout: string[]
  stderr: string[]
} {
  const stdout: string[] = []
  const stderr: string[] = []
  const calls: Array<{ operation: string; input: unknown }> = []
  return {
    stdout,
    stderr,
    calls,
    io: {
      stdin: async () => '',
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    },
    client: {
      request: async (operation, input) => {
        calls.push({ operation, input })
        return result
      },
      close: async () => undefined
    }
  }
}

describe('CrossHands JSON CLI', () => {
  it.runIf(process.platform === 'darwin')(
    'uses a private per-user macOS runtime path instead of shared temporary storage',
    () => {
      expect(localClientPaths().runtimeDirectory).toContain(
        join('Library', 'Caches', 'CrossHands', 'runtime')
      )
    }
  )

  it.each([
    ['capabilities', [], 'capabilities', {}],
    ['permissions', ['--id', 'accessibility'], 'permissions', { id: 'accessibility' }],
    ['list-apps', [], 'listApps', {}],
    ['list-windows', ['--app', 'fixture.app'], 'listWindows', { app: 'fixture.app' }],
    [
      'get-app-state',
      ['--app', 'fixture.app', '--window-index', '2', '--no-screenshot'],
      'getAppState',
      { app: 'fixture.app', window: { index: 2 }, captureScreenshot: false }
    ],
    [
      'click',
      ['--context', 'ctx_' + 'a'.repeat(32), '--element-index', '4'],
      'click',
      { contextToken: 'ctx_' + 'a'.repeat(32), target: { kind: 'element', elementIndex: 4 } }
    ],
    [
      'perform-secondary-action',
      ['--context', 'ctx_' + 'a'.repeat(32), '--element-index', '4', '--action', 'showMenu'],
      'performSecondaryAction',
      {
        contextToken: 'ctx_' + 'a'.repeat(32),
        target: { kind: 'element', elementIndex: 4 },
        action: 'showMenu'
      }
    ],
    [
      'scroll',
      ['--context', 'ctx_' + 'a'.repeat(32), '--x', '10', '--y', '20', '--direction', 'down'],
      'scroll',
      {
        contextToken: 'ctx_' + 'a'.repeat(32),
        target: { kind: 'coordinate', x: 10, y: 20 },
        direction: 'down'
      }
    ],
    [
      'drag',
      [
        '--context',
        'ctx_' + 'a'.repeat(32),
        '--from-element-index',
        '1',
        '--to-element-index',
        '8'
      ],
      'drag',
      {
        contextToken: 'ctx_' + 'a'.repeat(32),
        from: { kind: 'element', elementIndex: 1 },
        to: { kind: 'element', elementIndex: 8 }
      }
    ],
    [
      'type-text',
      ['--context', 'ctx_' + 'a'.repeat(32), '--text', 'hello'],
      'typeText',
      {
        contextToken: 'ctx_' + 'a'.repeat(32),
        target: { kind: 'context-window' },
        text: 'hello'
      }
    ],
    [
      'press-key',
      ['--context', 'ctx_' + 'a'.repeat(32), '--key', 'Return'],
      'pressKey',
      {
        contextToken: 'ctx_' + 'a'.repeat(32),
        target: { kind: 'context-window' },
        key: 'Return'
      }
    ],
    [
      'hotkey',
      ['--context', 'ctx_' + 'a'.repeat(32), '--key', 'CmdOrCtrl+Shift+P'],
      'hotkey',
      {
        contextToken: 'ctx_' + 'a'.repeat(32),
        target: { kind: 'context-window' },
        keys: ['CmdOrCtrl', 'Shift', 'P']
      }
    ],
    [
      'paste-text',
      ['--context', 'ctx_' + 'a'.repeat(32), '--text', 'hello'],
      'pasteText',
      {
        contextToken: 'ctx_' + 'a'.repeat(32),
        target: { kind: 'context-window' },
        text: 'hello'
      }
    ],
    [
      'set-value',
      ['--context', 'ctx_' + 'a'.repeat(32), '--element-index', '2', '--value', 'hello'],
      'setValue',
      {
        contextToken: 'ctx_' + 'a'.repeat(32),
        target: { kind: 'element', elementIndex: 2 },
        value: 'hello'
      }
    ]
  ])('maps computer %s to %s', async (command, flags, operation, input) => {
    const state = harness()
    const code = await runCli(
      ['computer', command as string, ...(flags as string[]), '--json'],
      state.io,
      state.client
    )
    expect(code).toBe(0)
    expect(state.calls).toEqual([{ operation, input }])
    expect(JSON.parse(state.stdout.join(''))).toEqual({ ok: true })
    expect(state.stderr).toEqual([])
  })

  it('rejects removed Orca routing flags with migration guidance', async () => {
    const state = harness()
    const code = await runCli(
      ['computer', 'get-app-state', '--app', 'fixture', '--worktree', 'current', '--json'],
      state.io,
      state.client
    )
    expect(code).toBe(2)
    expect(state.calls).toEqual([])
    expect(JSON.parse(state.stdout.join(''))).toMatchObject({
      error: { code: 'invalid_argument', remediation: 'remove_orca_routing_flag' }
    })
  })

  it('validates contradictory selectors before contacting the broker', async () => {
    const state = harness()
    const code = await runCli(
      [
        'computer',
        'click',
        '--context',
        'ctx_' + 'a'.repeat(32),
        '--element-index',
        '1',
        '--x',
        '2',
        '--y',
        '3',
        '--json'
      ],
      state.io,
      state.client
    )
    expect(code).toBe(2)
    expect(state.calls).toEqual([])
  })

  it('reads protected text only from stdin and never renders the canary', async () => {
    const canary = 'crosshands-secret-canary'
    const state = harness({ outcome: { state: 'verified' } })
    state.io.stdin = async () => canary
    const argv = [
      'computer',
      'set-value',
      '--context',
      'ctx_' + 'a'.repeat(32),
      '--element-index',
      '2',
      '--value-stdin',
      '--json'
    ]
    const code = await runCli(argv, state.io, state.client)
    expect(code).toBe(0)
    expect(argv.join(' ')).not.toContain(canary)
    expect(state.calls[0]).toMatchObject({ input: { value: canary } })
    expect(state.stdout.join('') + state.stderr.join('')).not.toContain(canary)
  })

  it('exports screenshots using a new restrictive file and refuses existing paths and links', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosshands-cli-'))
    const destination = join(directory, 'capture.png')
    const screenshot = Buffer.from('png fixture')
    const result = {
      result: {
        screenshot: {
          format: 'png',
          width: 1,
          height: 1,
          scale: 1,
          data: screenshot.toString('base64')
        }
      }
    }
    const state = harness(result)
    expect(
      await runCli(
        [
          'computer',
          'get-app-state',
          '--app',
          'fixture',
          '--screenshot-output',
          destination,
          '--json'
        ],
        state.io,
        state.client
      )
    ).toBe(0)
    expect(await readFile(destination)).toEqual(screenshot)
    expect((await stat(destination)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(state.stdout.join(''))).toMatchObject({
      result: { screenshot: { path: destination, bytes: screenshot.byteLength, dataOmitted: true } }
    })

    const existing = harness(result)
    expect(
      await runCli(
        [
          'computer',
          'get-app-state',
          '--app',
          'fixture',
          '--screenshot-output',
          destination,
          '--json'
        ],
        existing.io,
        existing.client
      )
    ).toBe(2)

    const target = join(directory, 'target')
    const link = join(directory, 'link.png')
    await writeFile(target, 'untouched')
    await symlink(target, link)
    const linked = harness(result)
    expect(
      await runCli(
        ['computer', 'get-app-state', '--app', 'fixture', '--screenshot-output', link, '--json'],
        linked.io,
        linked.client
      )
    ).toBe(2)
    expect(await readFile(target, 'utf8')).toBe('untouched')
  })

  it.each([
    ['permission_denied', 4],
    ['stale_target', 5],
    ['app_blocked', 6],
    ['unsupported_capability', 7],
    ['timeout', 8]
  ])('uses a stable exit code for %s', async (errorCode, expectedExit) => {
    const state = harness()
    state.client.request = async () => {
      throw Object.assign(new Error('safe diagnostic'), {
        code: errorCode,
        retry: false,
        remediation: 'run_doctor'
      })
    }
    const code = await runCli(['computer', 'capabilities', '--json'], state.io, state.client)
    expect(code).toBe(expectedExit)
    expect(JSON.parse(state.stdout.join(''))).toMatchObject({ error: { code: errorCode } })
  })

  it('auto-starts the protected broker seam and reaches the fake provider', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'crosshands-autostart-'))
    await chmod(runtimeDirectory, 0o700)
    const identity = { osIdentity: 'uid:test', graphicalSessionId: 'session:test' }
    const peer: BrokerPeer = { ...identity, verified: true, local: true }
    const paths: LocalClientPaths = {
      identity,
      runtimeDirectory,
      tokenFile: join(runtimeDirectory, 'control.token'),
      endpoint: { transport: 'unix', address: join(runtimeDirectory, 'control.sock') }
    }
    const provider = new FakeComputerProvider({ graphicalSessionId: identity.graphicalSessionId })
    provider.enqueue({
      kind: 'result',
      dispatched: false,
      result: {
        platform: 'linux',
        provider: 'crosshands-fake',
        providerVersion: '0.1.0',
        operations: { capabilities: true },
        permissions: { accessibility: 'granted', screenshots: 'granted' }
      }
    })
    const broker = new LocalBroker({ identity: peer, providerFactory: () => provider })
    await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    const server = new LocalControlServer({
      endpoint: paths.endpoint,
      runtimeDirectory,
      tokenFile: paths.tokenFile,
      identity,
      handler: ({ payload }) => {
        const request = payload as { operation: 'capabilities'; input: unknown }
        return broker.request(request)
      }
    })
    let starts = 0
    const client = await createProductionBrokerClient({
      paths,
      readinessMs: 1_000,
      entrypoint: '/installed/crosshands',
      spawnBroker: async () => {
        starts += 1
        await server.start()
      }
    })
    await expect(client.request('capabilities', {})).resolves.toMatchObject({
      result: { provider: 'crosshands-fake' }
    })
    expect(starts).toBe(1)
    expect(provider.calls).toHaveLength(1)
    await client.close()
    await server.close()
  })
})
