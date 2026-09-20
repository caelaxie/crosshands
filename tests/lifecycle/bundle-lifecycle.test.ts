import { describe, expect, it, vi } from 'vitest'

import {
  BundleLifecycle,
  BundleLifecycleError,
  planUninstall,
  type BundleCandidate,
  type InstalledResource
} from '../../packages/runtime/src/index.js'

function candidate(version: string, release: number): BundleCandidate {
  const artifacts = ['main', 'payload', 'notices'].map((name) => ({
    name,
    version,
    expectedDigest: `${version}-${name}`,
    actualDigest: `${version}-${name}`,
    trustVerified: true
  }))
  return {
    version,
    release,
    manifestDigest: `manifest-${version}`,
    requiredArtifacts: artifacts.map(({ name }) => name),
    artifacts
  }
}

async function runningLifecycle(): Promise<BundleLifecycle> {
  const lifecycle = new BundleLifecycle()
  lifecycle.stage(candidate('1.0.0', 1))
  await lifecycle.activate('1.0.0')
  return lifecycle
}

describe('whole-version staging and activation', () => {
  it('rejects partial, mixed-version, and integrity-failed bundles before activation', () => {
    const lifecycle = new BundleLifecycle()
    const partial = candidate('1.0.0', 1)
    expect(() =>
      lifecycle.stage({ ...partial, artifacts: partial.artifacts.slice(0, 2) })
    ).toThrowError(expect.objectContaining({ code: 'bundle_incomplete' }))

    const mixed = candidate('1.0.0', 1)
    const mixedArtifacts = [...mixed.artifacts]
    mixedArtifacts[1] = { ...mixedArtifacts[1]!, version: '2.0.0' }
    expect(() =>
      lifecycle.stage({
        ...mixed,
        artifacts: mixedArtifacts
      })
    ).toThrowError(expect.objectContaining({ code: 'bundle_version_mismatch' }))

    const modified = candidate('1.0.0', 1)
    const modifiedArtifacts = [...modified.artifacts]
    modifiedArtifacts[1] = { ...modifiedArtifacts[1]!, actualDigest: 'substituted' }
    expect(() =>
      lifecycle.stage({
        ...modified,
        artifacts: modifiedArtifacts
      })
    ).toThrowError(expect.objectContaining({ code: 'bundle_integrity' }))
  })

  it('keeps either the old or new complete bundle runnable across commit interruptions', async () => {
    const beforeCommit = await runningLifecycle()
    beforeCommit.stage(candidate('1.1.0', 2))
    await expect(
      beforeCommit.activate('1.1.0', {
        beforeCommit: () => {
          throw new Error('power loss before pointer swap')
        }
      })
    ).rejects.toThrow('power loss')
    expect(beforeCommit.activeVersion).toBe('1.0.0')
    expect(beforeCommit.bundle('1.0.0')).toBeDefined()
    expect(beforeCommit.bundle('1.1.0')).toBeDefined()
    expect(beforeCommit.phase).toBe('running')

    const afterCommit = await runningLifecycle()
    afterCommit.stage(candidate('1.1.0', 2))
    await expect(
      afterCommit.activate('1.1.0', {
        afterCommit: () => {
          throw new Error('broker restart interrupted')
        }
      })
    ).rejects.toThrow('interrupted')
    expect(afterCommit.activeVersion).toBe('1.1.0')
    expect(afterCommit.bundle('1.0.0')).toBeDefined()
    expect(afterCommit.bundle('1.1.0')).toBeDefined()
    expect(afterCommit.phase).toBe('running')
  })
})

describe('mutation, client, context, and compatibility transitions', () => {
  it('drains an admitted mutation and rejects new mutations during update', async () => {
    const lifecycle = await runningLifecycle()
    lifecycle.stage(candidate('1.1.0', 2))
    const finish = lifecycle.beginMutation()
    const activated = lifecycle.activate('1.1.0')

    await vi.waitFor(() => expect(lifecycle.phase).toBe('draining'))
    expect(() => lifecycle.beginMutation()).toThrowError(
      expect.objectContaining({ code: 'mutation_rejected' })
    )
    expect(lifecycle.activeVersion).toBe('1.0.0')
    finish()
    await activated
    expect(lifecycle.activeVersion).toBe('1.1.0')
    expect(lifecycle.inFlightMutations).toBe(0)
  })

  it('invalidates contexts and requires connected clients to reconnect after activation', async () => {
    const lifecycle = await runningLifecycle()
    lifecycle.connectClient('codex', '1.0.0')
    const context = lifecycle.issueContext()
    lifecycle.stage(candidate('1.1.0', 2))
    await lifecycle.activate('1.1.0')

    expect(lifecycle.isContextCurrent(context)).toBe(false)
    expect(lifecycle.client('codex')).toMatchObject({ reconnectRequired: true })
    expect(lifecycle.reconnectClient('codex', '1.0.0')).toMatchObject({
      reconnectRequired: false
    })
  })

  it('supports exactly one prior release while requiring broker/provider/payload identity', async () => {
    const lifecycle = await runningLifecycle()
    lifecycle.stage(candidate('1.1.0', 2))
    lifecycle.stage(candidate('1.2.0', 3))
    await lifecycle.activate('1.1.0')

    expect(() =>
      lifecycle.assertDispatchCompatible({
        client: '1.0.0',
        broker: '1.1.0',
        provider: '1.1.0',
        payload: '1.1.0'
      })
    ).not.toThrow()
    expect(() =>
      lifecycle.assertDispatchCompatible({
        client: '1.0.0',
        broker: '1.1.0',
        provider: '1.0.0',
        payload: '1.1.0'
      })
    ).toThrowError(expect.objectContaining({ code: 'version_incompatible' }))

    await lifecycle.activate('1.2.0')
    expect(() => lifecycle.connectClient('old-cli', '1.0.0')).toThrowError(
      expect.objectContaining({ code: 'version_incompatible' })
    )
  })

  it('supports upgrade, immediate downgrade, and rejects skipped releases', async () => {
    const lifecycle = await runningLifecycle()
    lifecycle.stage(candidate('1.1.0', 2))
    lifecycle.stage(candidate('2.0.0', 4))
    await lifecycle.activate('1.1.0')
    await lifecycle.rollback('1.0.0')
    expect(lifecycle.activeVersion).toBe('1.0.0')
    await expect(lifecycle.activate('2.0.0')).rejects.toMatchObject({
      code: 'version_incompatible'
    })
  })
})

describe('uninstall ownership boundaries', () => {
  const resources: InstalledResource[] = [
    { id: 'broker', kind: 'broker-registration', owner: 'crosshands' },
    { id: 'socket', kind: 'ipc', owner: 'crosshands' },
    { id: 'capture', kind: 'temporary-capture', owner: 'crosshands' },
    { id: 'diagnostics', kind: 'log', owner: 'crosshands' },
    { id: 'report', kind: 'export', owner: 'user' },
    { id: 'settings', kind: 'configuration', owner: 'user' },
    { id: 'tcc', kind: 'permission', owner: 'os' }
  ]

  it('removes only CrossHands runtime state and reports manual permission cleanup', () => {
    const plan = planUninstall(resources)
    expect(plan.remove.map(({ id }) => id)).toEqual(['broker', 'socket', 'capture', 'diagnostics'])
    expect(plan.preserve.map(({ id }) => id)).toEqual(['report', 'settings'])
    expect(plan.manual.map(({ id }) => id)).toEqual(['tcc'])
  })

  it('handles orphan cleanup, invalidates clients, and supports reinstall after uninstall', async () => {
    const lifecycle = await runningLifecycle()
    lifecycle.connectClient('omp', '1.0.0')
    const context = lifecycle.issueContext()
    const removed: string[] = []
    const plan = await lifecycle.uninstall(resources, (resource) => {
      removed.push(resource.id)
    })

    expect(removed).toEqual(['broker', 'socket', 'capture', 'diagnostics'])
    expect(plan.preserve.map(({ id }) => id)).toEqual(['report', 'settings'])
    expect(lifecycle.phase).toBe('uninstalled')
    expect(lifecycle.activeVersion).toBeUndefined()
    expect(lifecycle.client('omp')).toBeUndefined()
    expect(lifecycle.isContextCurrent(context)).toBe(false)

    lifecycle.stage(candidate('1.0.0', 1))
    await lifecycle.activate('1.0.0')
    expect(lifecycle.phase).toBe('running')
  })

  it('keeps installed state retryable when idempotent cleanup is interrupted', async () => {
    const lifecycle = await runningLifecycle()
    await expect(
      lifecycle.uninstall(resources, (resource) => {
        if (resource.id === 'socket') throw new Error('cleanup interrupted')
      })
    ).rejects.toThrow('cleanup interrupted')
    expect(lifecycle.activeVersion).toBe('1.0.0')
    expect(lifecycle.phase).toBe('running')
  })
})

it('exposes structured lifecycle errors', () => {
  const error = new BundleLifecycleError('bundle_incomplete', 'missing')
  expect(error).toMatchObject({ name: 'BundleLifecycleError', code: 'bundle_incomplete' })
})
