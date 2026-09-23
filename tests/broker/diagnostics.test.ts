import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CONTRACT_VERSIONS,
  createComputerError,
  type ReferenceBindings
} from '../../packages/contract/src/index.js'
import { FakeComputerProvider } from '../../packages/provider-testkit/src/index.js'
import {
  JsonlDiagnosticsWriter,
  LocalBroker,
  diagnosticError,
  diagnosticsDirectory,
  emitDiagnostic,
  graphicalSessionKey,
  type BrokerPeer,
  type DiagnosticRecord,
  type DiagnosticsSink
} from '../../packages/runtime/src/index.js'

const peer: BrokerPeer = {
  osIdentity: 'uid:501',
  graphicalSessionId: 'aqua:diagnostics',
  verified: true,
  local: true
}

const canary = 'CANARY_SECRET_5fc6aaf4'

function bindings(brokerGeneration = 'broker-diag'): ReferenceBindings {
  return {
    brokerGeneration,
    providerGeneration: 'provider-1',
    graphicalSessionId: peer.graphicalSessionId,
    process: { pid: 42, startedAt: '2026-07-10T00:00:00.000Z', executableId: 'fixture' },
    appId: 'fixture.app',
    window: { id: 'window-1', ownerPid: 42 },
    snapshotId: 'snapshot-1',
    desktopEpoch: 0
  }
}

function observedState(treeText: string, screenshot: unknown = null) {
  const value = bindings()
  return {
    bindings: value,
    snapshot: {
      id: value.snapshotId,
      app: {
        id: value.appId,
        name: 'Fixture',
        bundleId: value.appId,
        pid: value.process.pid,
        isRunning: true
      },
      window: {
        id: value.window.id,
        appId: value.appId,
        title: canary,
        index: 0,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        minimized: false
      },
      treeText,
      elementCount: 4,
      focusedElementRef: 'element:1',
      desktopEpoch: value.desktopEpoch
    },
    screenshot,
    issues: []
  }
}

function readJsonl(directory: string, generation: string): DiagnosticRecord[] {
  const files = readdirSync(directory)
    .filter((name) => name.startsWith(generation) && name.endsWith('.jsonl'))
    .toSorted()
  const lines: DiagnosticRecord[] = []
  for (const name of files) {
    const text = readFileSync(join(directory, name), 'utf8').trim()
    if (text.length === 0) continue
    for (const line of text.split('\n')) {
      lines.push(JSON.parse(line) as DiagnosticRecord)
    }
  }
  return lines
}

const directories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'crosshands-diagnostics-'))
  directories.push(directory)
  return directory
}

function listening(broker: LocalBroker, sink: DiagnosticsSink): void {
  emitDiagnostic(sink, { kind: 'broker.start', ...broker.diagnosticEnvelope() })
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop()
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  }
})

describe('diagnostics paths', () => {
  it('uses platform log directories and a stable session key', () => {
    const session = 'aqua:diagnostics'
    const key = graphicalSessionKey(session)
    expect(key).toHaveLength(12)
    expect(diagnosticsDirectory(session, { platform: 'darwin', env: {} })).toBe(
      join(homedir(), 'Library', 'Logs', 'CrossHands', key)
    )
    expect(
      diagnosticsDirectory(session, {
        platform: 'linux',
        env: { XDG_STATE_HOME: '/var/tmp/state' }
      })
    ).toBe(join('/var/tmp/state', 'crosshands', key))
    expect(
      diagnosticsDirectory(session, {
        platform: 'win32',
        env: { LOCALAPPDATA: join('C:', 'Users', 'kai', 'AppData', 'Local') }
      })
    ).toBe(join('C:', 'Users', 'kai', 'AppData', 'Local', 'CrossHands', 'logs', key))
    expect(
      diagnosticsDirectory(session, { env: { CROSSHANDS_DIAGNOSTICS_DIR: '/tmp/diag-override' } })
    ).toBe('/tmp/diag-override')
  })
})

describe('jsonl diagnostics writer', () => {
  it('appends one JSON object per line, rotates, and keeps the directory private', async () => {
    const directory = tempDir()
    const writer = new JsonlDiagnosticsWriter({
      directory,
      generation: 'broker-1',
      maxBytes: 120
    })
    writer.emit({
      v: 1,
      ts: '2026-04-03T18:00:00.000Z',
      session: 'aaaaaaaaaaaa',
      brokerGeneration: 'broker-1',
      desktopEpoch: 0,
      platform: 'darwin',
      kind: 'broker.start'
    })
    writer.emit({
      v: 1,
      ts: '2026-04-03T18:00:01.000Z',
      session: 'aaaaaaaaaaaa',
      brokerGeneration: 'broker-1',
      desktopEpoch: 0,
      platform: 'darwin',
      kind: 'broker.stop',
      reason: 'signal'
    })
    const files = readdirSync(directory).toSorted()
    expect(files).toEqual(['broker-1.2.jsonl', 'broker-1.jsonl'])
    const first = JSON.parse(readFileSync(join(directory, 'broker-1.jsonl'), 'utf8').trim())
    expect(first).toEqual({
      v: 1,
      ts: '2026-04-03T18:00:00.000Z',
      session: 'aaaaaaaaaaaa',
      brokerGeneration: 'broker-1',
      desktopEpoch: 0,
      platform: 'darwin',
      kind: 'broker.start'
    })
    if (process.platform !== 'win32') {
      expect(statSync(directory).mode & 0o777).toBe(0o700)
    }
    await writer.close()
  })
})

describe('diagnosticError', () => {
  it('keeps allow-listed scalar details and drops payloads', () => {
    const error = createComputerError('stale_target', 'Target reference is no longer fresh', {
      mismatches: ['context token'],
      treeText: canary
    })
    expect(diagnosticError(error)).toEqual({
      code: 'stale_target',
      message: 'Target reference is no longer fresh',
      retry: true,
      remediation: 'refresh_state',
      details: { mismatches: ['context token'] }
    })
    expect(JSON.stringify(diagnosticError(error))).not.toContain(canary)
  })
})

describe('local broker diagnostics file', () => {
  it('writes helper, request, and stop lines without desktop payloads', async () => {
    const directory = tempDir()
    const diagnostics = new JsonlDiagnosticsWriter({
      directory,
      generation: 'broker-diag'
    })
    const provider = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    }).enqueue({
      kind: 'result',
      result: observedState(canary, {
        format: 'png',
        width: 1,
        height: 1,
        scale: 1,
        data: canary
      }),
      dispatched: false
    })
    const broker = new LocalBroker({
      identity: peer,
      generation: 'broker-diag',
      providerFactory: () => provider,
      diagnostics
    })
    const client = await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    listening(broker, diagnostics)
    const response = await client.request({
      operation: 'getAppState',
      input: { app: 'fixture.app' }
    })
    expect(response.result).toMatchObject({ snapshot: { treeText: canary } })
    await broker.close()

    const records = readJsonl(directory, 'broker-diag')
    const kinds = records.map((record) => record.kind)
    expect(kinds).toEqual(['helper.start', 'broker.start', 'request', 'broker.stop'])
    expect(records.find((record) => record.kind === 'broker.stop')).toMatchObject({
      reason: 'closed'
    })
    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain(canary)
    expect(serialized).not.toContain('treeText')
    const request = records.find((record) => record.kind === 'request')
    expect(request).toMatchObject({
      kind: 'request',
      requestId: 'broker-1',
      operation: 'getAppState',
      mutation: false,
      v: 1,
      brokerGeneration: 'broker-diag',
      result: {
        type: 'observation',
        snapshotId: 'snapshot-1',
        elementCount: 4,
        focusedElementRef: 'element:1',
        screenshot: true,
        issues: []
      }
    })
    expect(readFileSync(join(directory, 'broker-diag.jsonl'), 'utf8').endsWith('\n')).toBe(true)
  })

  it('records a helper crash and restart on a retried observation', async () => {
    const directory = tempDir()
    const diagnostics = new JsonlDiagnosticsWriter({
      directory,
      generation: 'broker-crash'
    })
    const crashed = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    }).enqueue({ kind: 'crash', message: 'read crash' })
    const restarted = new FakeComputerProvider({
      generation: 'provider-2',
      graphicalSessionId: peer.graphicalSessionId
    }).enqueue({
      kind: 'result',
      result: observedState('ok'),
      dispatched: false
    })
    const providers = [crashed, restarted]
    const broker = new LocalBroker({
      identity: peer,
      generation: 'broker-crash',
      providerFactory: () => providers.shift()!,
      diagnostics
    })
    const client = await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    await client.request({ operation: 'getAppState', input: { app: 'fixture.app' } })
    await broker.close()
    expect(readJsonl(directory, 'broker-crash').map((record) => record.kind)).toEqual([
      'helper.start',
      'helper.crash',
      'helper.restart',
      'request',
      'broker.stop'
    ])
  })

  it('records typeText without the typed payload', async () => {
    const directory = tempDir()
    const diagnostics = new JsonlDiagnosticsWriter({
      directory,
      generation: 'broker-type'
    })
    const bound = bindings('broker-type')
    const provider = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    }).enqueue({ kind: 'result', result: { outcome: { state: 'verified' } } })
    const broker = new LocalBroker({
      identity: peer,
      generation: 'broker-type',
      providerFactory: () => provider,
      diagnostics,
      inspectTarget: async () => ({
        bindings: bound,
        appIdentity: { appId: 'fixture.app', executableId: 'fixture' }
      })
    })
    const client = await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    const context = broker.issueContext(bound)
    await client.request({
      operation: 'typeText',
      input: {
        contextToken: context.token,
        text: canary,
        target: {
          kind: 'element',
          ref: {
            ...bound,
            ref: 'element:2',
            kind: 'element',
            contextToken: context.token,
            expiresAt: '2099-01-01T00:00:00.000Z'
          }
        }
      }
    })
    await broker.close()
    const serialized = JSON.stringify(readJsonl(directory, 'broker-type'))
    expect(serialized).not.toContain(canary)
    expect(serialized).not.toContain(context.token)
    const request = readJsonl(directory, 'broker-type').find((record) => record.kind === 'request')
    expect(request).toMatchObject({
      operation: 'typeText',
      mutation: true,
      target: { appId: 'fixture.app', ref: 'element:2', kind: 'element' },
      result: { type: 'mutation', dispatched: true, outcome: { state: 'verified' } }
    })
  })

  it('records a skipped mutation by error code and leaves the message out', async () => {
    const directory = tempDir()
    const diagnostics = new JsonlDiagnosticsWriter({ directory, generation: 'broker-skip' })
    const bound = bindings('broker-skip')
    const provider = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    }).enqueue({
      kind: 'result',
      result: {
        outcome: {
          state: 'not_attempted',
          error: createComputerError('value_not_settable', canary).toJSON()
        }
      }
    })
    const broker = new LocalBroker({
      identity: peer,
      generation: 'broker-skip',
      providerFactory: () => provider,
      diagnostics,
      inspectTarget: async () => ({
        bindings: bound,
        appIdentity: { appId: 'fixture.app', executableId: 'fixture' }
      })
    })
    const client = await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    const context = broker.issueContext(bound)
    await client.request({
      operation: 'setValue',
      input: {
        contextToken: context.token,
        value: canary,
        target: { kind: 'element', elementIndex: 3 }
      }
    })
    await broker.close()
    const serialized = JSON.stringify(readJsonl(directory, 'broker-skip'))
    expect(serialized).not.toContain(canary)
    expect(serialized).not.toContain(context.token)
    const request = readJsonl(directory, 'broker-skip').find((record) => record.kind === 'request')
    expect(request).toMatchObject({
      operation: 'setValue',
      result: {
        type: 'mutation',
        outcome: { state: 'not_attempted', code: 'value_not_settable' }
      }
    })
    expect(JSON.stringify(request)).not.toContain(canary)
  })

  it('records the key name and the drag end without typed text', async () => {
    const directory = tempDir()
    const diagnostics = new JsonlDiagnosticsWriter({ directory, generation: 'broker-keys' })
    const bound = bindings('broker-keys')
    const provider = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    })
      .enqueue({
        kind: 'result',
        result: { outcome: { state: 'indeterminate', reason: 'synthetic_input' } }
      })
      .enqueue({ kind: 'result', result: { outcome: { state: 'verified' } } })
      .enqueue({ kind: 'result', result: { outcome: { state: 'verified' } } })
    const broker = new LocalBroker({
      identity: peer,
      generation: 'broker-keys',
      providerFactory: () => provider,
      diagnostics,
      inspectTarget: async () => ({
        bindings: bound,
        appIdentity: { appId: 'fixture.app', executableId: 'fixture' }
      })
    })
    const client = await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    const context = broker.issueContext(bound)
    const target = {
      kind: 'element' as const,
      ref: {
        ...bound,
        ref: 'element:2',
        kind: 'element' as const,
        contextToken: context.token,
        expiresAt: '2099-01-01T00:00:00.000Z'
      }
    }
    await client.request({
      operation: 'pressKey',
      input: { contextToken: context.token, key: 'return', text: canary, target }
    })
    await client.request({
      operation: 'hotkey',
      input: { contextToken: context.token, keys: ['command', 'v'], text: canary, target }
    })
    await client.request({
      operation: 'drag',
      input: {
        contextToken: context.token,
        text: canary,
        from: { kind: 'element', elementIndex: 1 },
        to: { kind: 'element', elementIndex: 4 }
      }
    })
    await broker.close()
    const serialized = JSON.stringify(readJsonl(directory, 'broker-keys'))
    expect(serialized).not.toContain(canary)
    const requests = readJsonl(directory, 'broker-keys').filter(
      (record) => record.kind === 'request'
    )
    expect(requests[0]).toMatchObject({ operation: 'pressKey', act: { key: 'return' } })
    expect(requests[0]).not.toHaveProperty('key')
    expect(requests[1]).toMatchObject({ operation: 'hotkey', act: { keys: ['command', 'v'] } })
    expect(requests[1]).not.toHaveProperty('keys')
    expect(requests[2]).toMatchObject({
      operation: 'drag',
      target: { ref: 'element:1', toRef: 'element:4' }
    })
  })

  it('records a screenshot request separately from the screenshot boolean', async () => {
    const directory = tempDir()
    const diagnostics = new JsonlDiagnosticsWriter({ directory, generation: 'broker-shot' })
    const provider = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    }).enqueue({
      kind: 'result',
      result: observedState(canary, { format: 'png', width: 1, height: 1, scale: 1, data: canary }),
      dispatched: false
    })
    const broker = new LocalBroker({
      identity: peer,
      generation: 'broker-shot',
      providerFactory: () => provider,
      diagnostics
    })
    const client = await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    listening(broker, diagnostics)
    await client.request({
      operation: 'getAppState',
      input: { app: 'fixture.app', captureScreenshot: false, restoreWindow: true }
    })
    await broker.close()
    const serialized = JSON.stringify(readJsonl(directory, 'broker-shot'))
    expect(serialized).not.toContain(canary)
    const request = readJsonl(directory, 'broker-shot').find((record) => record.kind === 'request')
    expect(request).toMatchObject({
      act: { captureScreenshot: false, restoreWindow: true },
      result: { type: 'observation', screenshot: true }
    })
    expect(request).not.toHaveProperty('captureScreenshot')
    expect(request).not.toHaveProperty('restoreWindow')
  })

  it('records capability operation flags', async () => {
    const directory = tempDir()
    const diagnostics = new JsonlDiagnosticsWriter({ directory, generation: 'broker-cap' })
    const provider = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    }).enqueue({
      kind: 'result',
      result: {
        platform: 'darwin',
        provider: 'crosshands-fake',
        providerVersion: '0',
        operations: { click: true, drag: false },
        permissions: { accessibility: 'granted' }
      },
      dispatched: false
    })
    const broker = new LocalBroker({
      identity: peer,
      generation: 'broker-cap',
      providerFactory: () => provider,
      diagnostics
    })
    const client = await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    await client.request({ operation: 'capabilities', input: {} })
    await broker.close()
    const request = readJsonl(directory, 'broker-cap').find((record) => record.kind === 'request')
    expect(request).toMatchObject({
      operation: 'capabilities',
      result: {
        type: 'lookup',
        operations: { click: true, drag: false },
        permissions: { accessibility: 'granted' }
      }
    })
  })

  it('records a fresh snapshot summary without the tree', async () => {
    const directory = tempDir()
    const diagnostics = new JsonlDiagnosticsWriter({ directory, generation: 'broker-fresh' })
    const bound = bindings('broker-fresh')
    const provider = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    }).enqueue({
      kind: 'result',
      result: {
        outcome: { state: 'verified' },
        freshState: {
          bindings: { ...bound, snapshotId: 'snapshot-2' },
          snapshot: {
            ...observedState(canary).snapshot,
            id: 'snapshot-2',
            elementCount: 9
          },
          screenshot: null,
          issues: [
            {
              code: 'screenshot_failed',
              message: canary,
              retry: true,
              remediation: 'check_screenshot_permission'
            }
          ]
        }
      }
    })
    const broker = new LocalBroker({
      identity: peer,
      generation: 'broker-fresh',
      providerFactory: () => provider,
      diagnostics,
      inspectTarget: async () => ({
        bindings: bound,
        appIdentity: { appId: 'fixture.app', executableId: 'fixture' }
      })
    })
    const client = await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    const context = broker.issueContext(bound)
    await client.request({
      operation: 'click',
      input: {
        contextToken: context.token,
        target: { kind: 'element', elementIndex: 2 }
      }
    })
    await broker.close()
    const serialized = JSON.stringify(readJsonl(directory, 'broker-fresh'))
    expect(serialized).not.toContain(canary)
    expect(serialized).not.toContain('ctx_')
    expect(serialized).not.toContain('treeText')
    const request = readJsonl(directory, 'broker-fresh').find((record) => record.kind === 'request')
    expect(request).toMatchObject({
      operation: 'click',
      result: {
        type: 'mutation',
        fresh: { snapshotId: 'snapshot-2', elementCount: 9, issues: ['screenshot_failed'] }
      }
    })
  })
})
