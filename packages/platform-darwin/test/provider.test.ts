import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  DarwinComputerProvider,
  normalizeScreenshotIssues,
  resolveHelperPath,
  verifyDarwinPayload
} from '../src/index.js'

const app = {
  name: 'Fixture',
  bundleId: 'ai.crosshands.fixture',
  pid: 42,
  processStartedAt: '2026-07-10T00:00:00Z',
  executableId: '/Applications/Fixture.app/Contents/MacOS/Fixture',
  isRunning: true
}

const window = {
  id: 7,
  index: 1,
  title: 'Fixture Window',
  x: 10,
  y: 20,
  width: 800,
  height: 600,
  isMinimized: false
}

const snapshot = {
  snapshot: {
    id: 'snapshot-1',
    app,
    window,
    treeText: '0 button Save',
    elementCount: 1,
    focusedElementId: 0
  },
  screenshot: { format: 'png', width: 1600, height: 1200, scale: 2, data: 'cG5n' },
  action: { verification: { state: 'verified', property: 'value' } }
}

function harness() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const client = {
    async request(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'handshake') {
        return {
          provider: 'crosshands-darwin',
          generation: 'darwin-1',
          graphicalSessionId: 'session-1',
          providerProtocol: 1,
          publicContract: '1.1.0',
          capabilities: {
            platform: 'darwin',
            provider: 'crosshands-darwin',
            providerVersion: '1.0.0',
            operations: { getAppState: true, click: true },
            permissions: { accessibility: 'granted', screenshots: 'granted' }
          }
        }
      }
      if (method === 'listApps') return { apps: [app] }
      if (method === 'listWindows') return { app, windows: [window] }
      return snapshot
    },
    async close() {}
  }
  return {
    calls,
    provider: new DarwinComputerProvider('session-1', async () => client)
  }
}

describe('@crosshands/platform-darwin', () => {
  it('preserves actionable screenshot permission and capture issues', () => {
    expect(
      normalizeScreenshotIssues({
        state: 'failed',
        code: 'permission_denied',
        message: 'Screen Recording permission is required'
      })
    ).toEqual([
      expect.objectContaining({
        code: 'permission_denied',
        retry: false,
        remediation: 'grant_permission'
      })
    ])
    expect(normalizeScreenshotIssues({ state: 'captured' })).toEqual([])
  })

  it('verifies version, bundle identity, and helper digest before launch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosshands-darwin-integrity-'))
    const helperPath = join(directory, 'crosshands-computer-use-macos')
    const manifestPath = join(directory, 'payload.json')
    const helper = Buffer.from('fixture helper')
    await writeFile(helperPath, helper)
    await writeFile(
      manifestPath,
      JSON.stringify({
        productVersion: '0.1.0',
        bundleIdentifier: 'ai.crosshands.ComputerUse',
        files: {
          'crosshands-computer-use-macos': createHash('sha256').update(helper).digest('hex')
        }
      })
    )
    await expect(verifyDarwinPayload(helperPath, manifestPath, false)).resolves.toBeUndefined()
    await writeFile(helperPath, 'substituted helper')
    await expect(verifyDarwinPayload(helperPath, manifestPath, false)).rejects.toMatchObject({
      code: 'provider_unavailable'
    })
  })

  it('resolves the helper from the package asset directory', () => {
    expect(resolveHelperPath()).toBe(
      fileURLToPath(
        new URL(
          '../assets/CrossHands%20Computer%20Use.app/Contents/MacOS/crosshands-computer-use-macos',
          import.meta.url
        )
      )
    )
  })

  it('normalizes native snapshots with stable process/window bindings and mixed scale', async () => {
    const { provider } = harness()
    const response = await provider.dispatch({
      requestId: 'r1',
      operation: 'getAppState',
      input: { app: 'Fixture', window: { id: '7' } },
      deadlineAt: Date.now() + 1_000
    })
    expect(response).toMatchObject({
      dispatched: false,
      result: {
        bindings: {
          providerGeneration: 'darwin-1',
          process: { pid: 42, executableId: app.executableId },
          window: { id: '7', ownerPid: 42 }
        },
        snapshot: { window: { index: 1, minimized: false } },
        screenshot: { width: 1600, height: 1200, scale: 2 }
      }
    })
  })

  it('maps semantic actions to snapshot-bound native requests and returns verified fresh state', async () => {
    const { calls, provider } = harness()
    await provider.start()
    const reference = {
      brokerGeneration: 'broker-1',
      providerGeneration: 'darwin-1',
      graphicalSessionId: 'session-1',
      process: { pid: 42, startedAt: app.processStartedAt, executableId: app.executableId },
      appId: app.bundleId,
      window: { id: '7', ownerPid: 42 },
      snapshotId: 'snapshot-1',
      desktopEpoch: 0,
      ref: 'element:0',
      kind: 'element',
      contextToken: `ctx_${'a'.repeat(32)}`,
      expiresAt: '2026-07-10T01:00:00Z'
    } as const
    const response = await provider.dispatch({
      requestId: 'r2',
      operation: 'click',
      input: {
        contextToken: reference.contextToken,
        target: { kind: 'element', ref: reference }
      },
      deadlineAt: Date.now() + 1_000
    })
    const modified = await provider.dispatch({
      requestId: 'r2-modifiers',
      operation: 'click',
      input: {
        contextToken: reference.contextToken,
        target: { kind: 'element', ref: reference },
        modifiers: ['Shift', 'CmdOrCtrl']
      },
      deadlineAt: Date.now() + 1_000
    })
    expect(calls.at(-1)).toMatchObject({
      method: 'click',
      params: {
        app: 'pid:42',
        elementIndex: 0,
        snapshotId: 'snapshot-1',
        expectedProcessStartedAt: app.processStartedAt,
        expectedExecutableId: app.executableId,
        modifiers: ['Shift', 'CmdOrCtrl']
      }
    })
    expect(modified).toMatchObject({ dispatched: true })
    expect(response).toMatchObject({
      dispatched: true,
      result: { outcome: { state: 'verified' }, freshState: { snapshot: { id: 'snapshot-1' } } }
    })
  })

  it('re-resolves process and window identity for broker preflight', async () => {
    const { provider } = harness()
    await provider.start()
    const inspection = await provider.inspect('getAppState', {
      app: 'Fixture',
      window: { id: '7' }
    })
    expect(inspection).toEqual({
      bindings: expect.objectContaining({
        process: expect.objectContaining({ startedAt: app.processStartedAt }),
        window: { id: '7', ownerPid: 42 }
      }),
      appIdentity: { appId: app.bundleId, executableId: app.executableId }
    })
  })
})
