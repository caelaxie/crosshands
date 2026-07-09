import { open, lstat, readFile, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export type UnixRuntimeValidationOptions = {
  uid: number
  stopAt?: string
}

export async function validateUnixRuntimeDirectory(
  runtimeDirectory: string,
  options: UnixRuntimeValidationOptions
): Promise<void> {
  const stopAt = resolve(options.stopAt ?? runtimeDirectory)
  let current = resolve(runtimeDirectory)
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- path components must be checked in order.
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) throw new Error('Unix runtime path contains a symbolic link')
    if (!stat.isDirectory()) throw new Error('Unix runtime path is not a directory')
    if (stat.uid !== options.uid) throw new Error('Unix runtime directory has unsafe ownership')
    if ((stat.mode & 0o077) !== 0) throw new Error('Unix runtime directory has unsafe mode')
    if (current === stopAt) break
    const parent = dirname(current)
    if (parent === current || !current.startsWith(`${stopAt}/`)) {
      throw new Error('Unix runtime directory escaped its validated root')
    }
    current = parent
  }
}

type UnixLeaseOptions = {
  runtimeDirectory: string
  endpoint: string
  owner: string
  isProcessAlive: (pid: number) => boolean
}

export type UnixLease = { release(): Promise<void> }

async function rejectPrecreatedEndpoint(endpoint: string): Promise<void> {
  try {
    await lstat(endpoint)
    throw new Error('Broker endpoint already exists or was precreated')
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return
    throw cause
  }
}

export async function acquireUnixLease(options: UnixLeaseOptions): Promise<UnixLease> {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('Unix lease is unsupported on this platform')
  await validateUnixRuntimeDirectory(options.runtimeDirectory, {
    uid,
    stopAt: options.runtimeDirectory
  })
  const leasePath = `${options.endpoint}.lease`
  await rejectPrecreatedEndpoint(options.endpoint)

  let handle
  try {
    handle = await open(leasePath, 'wx', 0o600)
  } catch (cause) {
    if (!(cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')) throw cause
    let stale = false
    try {
      const existing = JSON.parse(await readFile(leasePath, 'utf8')) as { pid?: unknown }
      stale = typeof existing.pid === 'number' && !options.isProcessAlive(existing.pid)
    } catch (parseCause) {
      throw new Error('Existing broker lease is unverifiable', { cause: parseCause })
    }
    if (!stale) throw new Error('A compatible broker lease is already active', { cause })
    await unlink(leasePath)
    await rejectPrecreatedEndpoint(options.endpoint)
    handle = await open(leasePath, 'wx', 0o600)
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, owner: options.owner }), 'utf8')
  await handle.sync()
  await handle.close()
  let released = false
  return {
    async release() {
      if (released) return
      released = true
      await unlink(leasePath).catch((cause: unknown) => {
        if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause
      })
    }
  }
}
