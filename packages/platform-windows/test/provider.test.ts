import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ProviderRequest, TargetReference } from '@crosshands/contract'

import {
  WindowsComputerProvider,
  normalizeScreenshotIssues,
  verifyWindowsPayload,
  windowsPowerShellLaunchSpec,
  type NativeFrame,
  type NativeWindowsTransport
} from '../src/provider.js'

class FakeTransport implements NativeWindowsTransport {
  readonly requests: Record<string, unknown>[] = []
  readonly responses: NativeFrame[]
  cancellations = 0

  constructor(...responses: NativeFrame[]) {
    this.responses = responses
  }

  async start(): Promise<NativeFrame> {
    return { ok: true, ready: true }
  }

  async request(payload: Record<string, unknown>): Promise<NativeFrame> {
    this.requests.push(structuredClone(payload))
    return this.responses.shift() ?? { ok: false, error: 'missing fake response' }
  }

  async cancel(): Promise<void> {
    this.cancellations += 1
  }

  async close(): Promise<void> {}
}

const identity = {
  pid: 42,
  startedAt: '2026-07-10T00:00:00.000Z',
  sessionId: 1,
  desktop: 'Default',
  executablePath: 'C:\\Program Files\\Fixture App\\fixture.exe',
  integrityRid: 8192,
  publisher: 'CN=Fixture',
  sha256: 'a'.repeat(64)
}

function nativeSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    snapshotId: 'snapshot-1',
    app: { name: 'Fixture', bundleId: 'fixture', pid: 42 },
    processIdentity: identity,
    windowId: 7,
    windowTitle: 'One',
    windowBounds: { x: -100, y: 20, width: 900, height: 700 },
    treeLines: ['button "Save"', 'edit "Password", Value: [redacted]'],
    elements: [{ index: 0, runtimeId: [1, 2] }],
    screenshotPngBase64: 'cG5n',
    screenshotWidth: 900,
    screenshotHeight: 700,
    screenshotScale: 1,
    ...overrides
  }
}

function request(operation: ProviderRequest['operation'], input: unknown): ProviderRequest {
  return { requestId: 'request-1', operation, input, deadlineAt: Date.now() + 5_000 }
}

describe('WindowsComputerProvider', () => {
  it('preserves actionable screenshot capture issues', () => {
    expect(
      normalizeScreenshotIssues({
        code: 'screenshot_failed',
        message: 'target-window screenshot capture failed'
      })
    ).toEqual([
      expect.objectContaining({
        code: 'screenshot_failed',
        retry: true,
        remediation: 'check_screenshot_permission'
      })
    ])
  })

  it('verifies the packaged payload and rejects a substituted script', async () => {
    await expect(verifyWindowsPayload()).resolves.toBeUndefined()
    const directory = await mkdtemp(join(tmpdir(), 'crosshands-windows-integrity-'))
    const scriptPath = join(directory, 'runtime.ps1')
    const manifestPath = join(directory, 'payload.json')
    await writeFile(
      scriptPath,
      `${await readFile(new URL('../assets/runtime.ps1', import.meta.url), 'utf8')}# tampered\n`
    )
    await writeFile(
      manifestPath,
      await readFile(new URL('../assets/payload.json', import.meta.url), 'utf8')
    )
    await expect(verifyWindowsPayload(scriptPath, manifestPath)).rejects.toMatchObject({
      code: 'provider_unavailable'
    })
  })

  it('normalizes discovery and bounded snapshots while redaction stays native-side', async () => {
    const transport = new FakeTransport(
      {
        ok: true,
        apps: [{ name: 'Fixture', bundleId: 'fixture', pid: 42 }]
      },
      {
        ok: true,
        windows: [
          {
            id: 7,
            index: 0,
            app: { bundleId: 'fixture' },
            title: 'One',
            x: -100,
            y: 20,
            width: 900,
            height: 700,
            isMinimized: false
          }
        ]
      },
      {
        ok: true,
        snapshot: nativeSnapshot()
      }
    )
    const provider = new WindowsComputerProvider({ transport, graphicalSessionId: 'console:1' })
    await expect(provider.dispatch(request('listApps', {}))).resolves.toMatchObject({
      result: { apps: [{ id: 'fixture', isRunning: true }] }
    })
    await expect(
      provider.dispatch(request('listWindows', { app: 'fixture' }))
    ).resolves.toMatchObject({
      result: { windows: [{ id: '7', bounds: { x: -100, width: 900 } }] }
    })
    await expect(
      provider.dispatch(request('getAppState', { app: 'fixture' }))
    ).resolves.toMatchObject({
      result: {
        bindings: {
          graphicalSessionId: 'console:1',
          process: { pid: 42, startedAt: identity.startedAt },
          window: { id: '7', ownerPid: 42 }
        },
        snapshot: { elementCount: 1, treeText: expect.stringContaining('[redacted]') },
        screenshot: { format: 'png', width: 900 }
      }
    })
    expect(transport.requests.map((value) => value.tool)).toEqual([
      'list_apps',
      'list_windows',
      'get_app_state'
    ])
  })

  it('re-resolves process identity and carries it in the stdin mutation envelope', async () => {
    const transport = new FakeTransport(
      { ok: true, identity, appId: 'fixture', windowId: 7, windowTitle: 'One' },
      {
        ok: true,
        action: { verification: { state: 'verified' } },
        snapshot: nativeSnapshot()
      }
    )
    const provider = new WindowsComputerProvider({ transport, graphicalSessionId: 'console:1' })
    const ref: TargetReference = {
      kind: 'element',
      ref: 'element:0',
      contextToken: `ctx_${'a'.repeat(32)}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      brokerGeneration: 'broker-1',
      providerGeneration: provider.generation,
      graphicalSessionId: 'console:1',
      process: { pid: 42, startedAt: identity.startedAt, executableId: 'old' },
      appId: 'fixture',
      window: { id: '7', ownerPid: 42 },
      snapshotId: 'snapshot-1',
      desktopEpoch: 3
    }
    const input = {
      contextToken: ref.contextToken,
      target: { kind: 'element', ref }
    }
    const inspection = await provider.inspect('click', input)
    expect(inspection).toMatchObject({
      bindings: { brokerGeneration: 'broker-1', desktopEpoch: 3, process: { pid: 42 } }
    })
    await expect(provider.dispatch(request('click', input))).resolves.toMatchObject({
      dispatched: true,
      result: {
        outcome: { state: 'verified' },
        freshState: { snapshot: { id: 'snapshot-1' }, issues: [] }
      }
    })
    expect(transport.requests[1]).toMatchObject({
      tool: 'click',
      app: 'fixture',
      expectedIdentity: identity,
      windowId: '7'
    })
  })

  it('labels preflight security failures non-dispatched and never retries them', async () => {
    const transport = new FakeTransport({
      ok: false,
      error: 'session_unavailable: the interactive desktop is locked or unavailable'
    })
    const provider = new WindowsComputerProvider({ transport })
    await expect(
      provider.dispatch(
        request('click', { app: 'fixture', target: { kind: 'coordinate', x: 1, y: 2 } })
      )
    ).resolves.toMatchObject({
      dispatched: false,
      error: { code: 'session_unavailable' }
    })
    expect(transport.requests).toHaveLength(1)
  })

  it('launches Windows PowerShell 5.1 by absolute path without profile, pwsh, or poisoned env', () => {
    const launch = windowsPowerShellLaunchSpec('C:\\Program Files\\CrossHands\\runtime.ps1', {
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\agent',
      PATH: 'C:\\poison',
      PSModulePath: 'C:\\poison-modules'
    })
    expect(launch.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(launch.args).toContain('-NoProfile')
    expect(launch.args).toContain('C:\\Program Files\\CrossHands\\runtime.ps1')
    expect(launch.args.join(' ')).not.toContain('pwsh')
    expect(launch.env).not.toHaveProperty('PATH')
    expect(launch.env).not.toHaveProperty('PSModulePath')
    expect(launch.env.PSModuleAutoLoadingPreference).toBe('None')
  })
})
