import { chmod, lstat, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  acquireUnixLease,
  brokerEndpoint,
  decodeFrames,
  encodeFrame,
  validateUnixRuntimeDirectory,
  windowsPipeSecurity
} from '../../packages/runtime/src/index.js'

describe('restricted local IPC', () => {
  it('keys endpoints by OS identity and graphical session without a network listener', () => {
    expect(
      brokerEndpoint({
        platform: 'linux',
        osIdentity: 'uid:501',
        graphicalSessionId: 'wayland:1',
        runtimeDirectory: '/run/user/501/crosshands'
      })
    ).toMatchObject({ transport: 'unix', address: expect.stringMatching(/\.sock$/) })
    expect(
      brokerEndpoint({
        platform: 'win32',
        osIdentity: 'sid:S-1-5-21',
        graphicalSessionId: 'logon:4'
      })
    ).toMatchObject({
      transport: 'named-pipe',
      address: expect.stringMatching(/^\\\\\.\\pipe\\crosshands-/)
    })
  })

  it('rejects unsafe Unix directories and precreated endpoints while electing one lease owner', async () => {
    const root = join(tmpdir(), `crosshands-ipc-${randomUUID()}`)
    await mkdir(root, { mode: 0o700 })
    await chmod(root, 0o777)
    await expect(
      validateUnixRuntimeDirectory(root, { uid: process.getuid!(), stopAt: root })
    ).rejects.toThrow(/mode/)
    await chmod(root, 0o700)
    const socket = join(root, 'broker.sock')
    await writeFile(socket, 'attacker')
    await expect(
      acquireUnixLease({
        runtimeDirectory: root,
        endpoint: socket,
        owner: 'one',
        isProcessAlive: () => true
      })
    ).rejects.toThrow(/endpoint/)
    await (await import('node:fs/promises')).unlink(socket)
    const [a, b] = await Promise.allSettled([
      acquireUnixLease({
        runtimeDirectory: root,
        endpoint: socket,
        owner: 'one',
        isProcessAlive: () => true
      }),
      acquireUnixLease({
        runtimeDirectory: root,
        endpoint: socket,
        owner: 'two',
        isProcessAlive: () => true
      })
    ])
    expect([a.status, b.status].toSorted()).toEqual(['fulfilled', 'rejected'])
    const winner =
      a.status === 'fulfilled' ? a.value : b.status === 'fulfilled' ? b.value : undefined
    await winner?.release()

    const link = join(root, 'link')
    await symlink(root, link)
    await expect(
      validateUnixRuntimeDirectory(link, { uid: process.getuid!(), stopAt: link })
    ).rejects.toThrow(/symbolic link/)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })

  it('bounds and rejects malformed frames', () => {
    const frame = encodeFrame({ type: 'cancel', requestId: 'r1' }, 1024)
    expect(decodeFrames(frame, 1024)).toEqual([{ type: 'cancel', requestId: 'r1' }])
    expect(() => encodeFrame({ payload: 'x'.repeat(20) }, 8)).toThrow(/maximum/)
    expect(() => decodeFrames(Buffer.from([0, 0, 0, 8]), 1024)).toThrow(/incomplete/)
  })

  it('does not pretend Windows DACL or peer guarantees exist on other platforms', () => {
    if (process.platform !== 'win32') expect(() => windowsPipeSecurity()).toThrow(/Windows/)
  })
})
