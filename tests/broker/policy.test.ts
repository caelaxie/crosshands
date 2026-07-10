import { describe, expect, it } from 'vitest'

import {
  SecretSafeDiagnostics,
  classifyApp,
  redactProtectedContent
} from '../../packages/runtime/src/index.js'

describe('broker policy', () => {
  it.each([
    'com.1password.1password',
    'com.bitwarden.desktop',
    'com.apple.keychainaccess',
    'org.keepassxc.keepassxc'
  ])('blocks sensitive app identity %s', (appId) => {
    expect(classifyApp({ appId, executableId: appId })).toBe('sensitive')
  })

  it('redacts protected fields recursively and never records operation content', () => {
    const canary = 'CANARY_SECRET_5fc6aaf4'
    expect(
      redactProtectedContent({
        role: 'password',
        value: canary,
        nested: { protected: true, text: canary }
      })
    ).toEqual({ role: 'password', value: '[REDACTED]', nested: '[REDACTED]' })
    const diagnostics = new SecretSafeDiagnostics()
    diagnostics.operation('typeText', { text: canary, target: { appId: 'fixture.app' } })
    diagnostics.error('provider crashed', new Error(canary))
    expect(JSON.stringify(diagnostics.entries)).not.toContain(canary)
    expect(diagnostics.entries).toMatchObject([
      { event: 'operation', operation: 'typeText' },
      { event: 'error', message: 'provider crashed' }
    ])
  })
})
