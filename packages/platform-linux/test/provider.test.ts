import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  LinuxComputerProvider,
  linuxProviderEnvironment,
  mapNativeOperation,
  normalizeNativeError,
  verifyLinuxPayload
} from '../src/index.js'

describe('Linux provider boundary', () => {
  test('uses a fixed environment and removes Python and caller search paths', () => {
    const environment = linuxProviderEnvironment({
      PATH: '/poison',
      PYTHONPATH: '/tmp/attacker',
      PYTHONHOME: '/tmp/home',
      LD_PRELOAD: '/tmp/inject.so',
      XDG_SESSION_TYPE: 'x11',
      DISPLAY: ':7',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_RUNTIME_DIR: '/run/user/1000'
    })

    expect(environment).toMatchObject({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      PYTHONNOUSERSITE: '1',
      XDG_SESSION_TYPE: 'x11',
      DISPLAY: ':7'
    })
    expect(environment).not.toHaveProperty('PYTHONPATH')
    expect(environment).not.toHaveProperty('PYTHONHOME')
    expect(environment).not.toHaveProperty('LD_PRELOAD')
  })

  test('maps contract operations without putting literal input in argv or files', () => {
    expect(mapNativeOperation('hotkey', { app: 'Editor', keys: ['ctrl', 'shift', 'p'] })).toEqual({
      tool: 'hotkey',
      app: 'Editor',
      key: 'ctrl+shift+p'
    })
    expect(
      mapNativeOperation('click', {
        app: 'Editor',
        target: { kind: 'coordinate', x: 12, y: 34 },
        clickCount: 2,
        button: 'right'
      })
    ).toMatchObject({ tool: 'click', app: 'Editor', x: 12, y: 34, click_count: 2 })
  })

  test.each([
    ['provider_unavailable: session bus missing', 'provider_unavailable'],
    ['unsupported_capability: hotkey is unavailable', 'unsupported_capability'],
    ['stale element frame', 'stale_target'],
    ['appBlocked("Secrets")', 'app_blocked'],
    ['appNotFound("Missing")', 'app_not_found']
  ])('normalizes native error %s', (message, code) => {
    expect(normalizeNativeError(message).code).toBe(code)
  })

  test('rejects a payload whose bytes do not match its manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosshands-linux-payload-'))
    const runtime = join(directory, 'runtime.py')
    const manifest = join(directory, 'payload.json')
    await writeFile(runtime, 'print("changed")', 'utf8')
    await writeFile(manifest, JSON.stringify({ files: { 'runtime.py': '0'.repeat(64) } }), 'utf8')
    await expect(verifyLinuxPayload(runtime, manifest)).rejects.toMatchObject({
      code: 'provider_unavailable'
    })
  })

  test('constructs with an absolute packaged runtime path', () => {
    const provider = new LinuxComputerProvider()
    expect(provider.runtimePath.startsWith('/')).toBe(true)
  })

  test('starts the packaged persistent provider and reports headless readiness precisely', async () => {
    const provider = new LinuxComputerProvider({ environment: {} })
    try {
      const handshake = await provider.start()
      expect(handshake.provider).toBe('crosshands-computer-use-linux')
      expect(handshake.publicContract).toBe('1.0.0')
      expect(handshake.capabilities.operations.capabilities).toBe(true)
      expect(handshake.capabilities.operations.getAppState).toBe(false)
      const response = await provider.dispatch({
        requestId: 'capabilities-1',
        operation: 'capabilities',
        input: {},
        deadlineAt: Date.now() + 1_000
      })
      expect(response).toMatchObject({
        requestId: 'capabilities-1',
        dispatched: false,
        result: { platform: 'linux' }
      })
    } finally {
      await provider.close()
    }
  })
})
