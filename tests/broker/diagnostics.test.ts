import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CONTRACT_VERSIONS, type ReferenceBindings } from '../../packages/contract/src/index.js'
import { FakeComputerProvider } from '../../packages/provider-testkit/src/index.js'
import {
  JsonlDiagnosticsWriter,
  LocalBroker,
  diagnosticsDirectory,
  diagnosticsResource,
  graphicalSessionKey,
  omitForbidden,
  type BrokerPeer,
  type DiagnosticRecord
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
    expect(diagnosticsResource('/tmp/diag').kind).toBe('log')
  })
})

describe('jsonl diagnostics writer', () => {
  it('appends one JSON object per line, rotates, and keeps the directory private', () => {
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
  })
})

describe('omitForbidden', () => {
  it('drops payloads that must not land on disk', () => {
    expect(
      omitForbidden({
        operation: 'typeText',
        text: canary,
        nested: { treeText: canary, value: canary, code: 'ok' }
      })
    ).toEqual({ operation: 'typeText', nested: { code: 'ok' } })
  })
})

describe('local broker diagnostics file', () => {
  it('writes helper, request, and stop lines without desktop payloads', async () => {
    const directory = tempDir()
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
      diagnosticsDirectory: directory
    })
    const client = await broker.connect({ peer, versions: CONTRACT_VERSIONS })
    broker.markListening()
    const response = await client.request({
      operation: 'getAppState',
      input: { app: 'fixture.app' }
    })
    expect(response.result).toMatchObject({ snapshot: { treeText: canary } })
    await broker.close()

    const records = readJsonl(directory, 'broker-diag')
    const kinds = records.map((record) => record.kind)
    expect(kinds).toEqual(['helper.start', 'broker.start', 'request', 'broker.stop'])
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
      diagnosticsDirectory: directory
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
    const bound = bindings('broker-type')
    const provider = new FakeComputerProvider({
      generation: 'provider-1',
      graphicalSessionId: peer.graphicalSessionId
    }).enqueue({ kind: 'result', result: { outcome: { state: 'verified' } } })
    const broker = new LocalBroker({
      identity: peer,
      generation: 'broker-type',
      providerFactory: () => provider,
      diagnosticsDirectory: directory,
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
})
