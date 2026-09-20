import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { CONTRACT_VERSIONS, createComputerError } from '@crosshands/contract'
import {
  LocalControlClient,
  brokerEndpoint,
  graphicalSessionKey,
  type LocalControlIdentity
} from '@crosshands/runtime'

import type { CliBrokerClient } from './index.js'

export type LocalClientPaths = {
  identity: LocalControlIdentity
  runtimeDirectory: string
  tokenFile: string
  endpoint: ReturnType<typeof brokerEndpoint>
}

export function localClientPaths(): LocalClientPaths {
  const uid = process.getuid?.()
  const osIdentity =
    process.env.CROSSHANDS_OS_IDENTITY ??
    (uid === undefined
      ? `user:${process.env.USERNAME ?? process.env.USER ?? 'unknown'}`
      : `uid:${uid}`)
  const graphicalSessionId =
    process.env.CROSSHANDS_GRAPHICAL_SESSION_ID ??
    process.env.XDG_SESSION_ID ??
    process.env.SECURITYSESSIONID ??
    process.env.SESSIONNAME ??
    `interactive:${osIdentity}`
  const sessionKey = graphicalSessionKey(graphicalSessionId)
  const runtimeDirectory = process.env.CROSSHANDS_RUNTIME_DIR ?? defaultRuntimeDirectory(sessionKey)
  const identity = { osIdentity, graphicalSessionId }
  return {
    identity,
    runtimeDirectory,
    tokenFile: join(runtimeDirectory, 'control.token'),
    endpoint: brokerEndpoint({
      platform: process.platform,
      osIdentity,
      graphicalSessionId,
      ...(process.platform === 'win32' ? {} : { runtimeDirectory })
    })
  }
}

function defaultRuntimeDirectory(sessionKey: string): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'CrossHands', 'runtime', sessionKey)
  }
  if (process.platform === 'linux') {
    const xdgRuntimeDirectory = process.env.XDG_RUNTIME_DIR
    if (xdgRuntimeDirectory === undefined || xdgRuntimeDirectory.length === 0) {
      throw createComputerError(
        'session_unavailable',
        'XDG_RUNTIME_DIR is required for a protected CrossHands broker endpoint'
      )
    }
    return join(xdgRuntimeDirectory, 'crosshands', sessionKey)
  }
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData === undefined || localAppData.length === 0) {
    throw createComputerError(
      'session_unavailable',
      'LOCALAPPDATA is required for CrossHands runtime state on Windows'
    )
  }
  return join(localAppData, 'CrossHands', 'runtime', sessionKey)
}

async function prepareRuntimeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw createComputerError('provider_unavailable', 'CrossHands runtime path is unsafe')
  if (process.getuid !== undefined && info.uid !== process.getuid())
    throw createComputerError('provider_unavailable', 'CrossHands runtime path has another owner')
  await chmod(path, 0o700)
}

async function readSecureToken(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw createComputerError('provider_unavailable', 'CrossHands broker token file is unsafe')
  if (process.getuid !== undefined && info.uid !== process.getuid())
    throw createComputerError('provider_unavailable', 'CrossHands broker token has another owner')
  return (await readFile(path, 'utf8')).trim()
}

async function connect(paths: LocalClientPaths): Promise<LocalControlClient> {
  const token = paths.endpoint.transport === 'unix' ? await readSecureToken(paths.tokenFile) : ''
  return LocalControlClient.connect({
    endpoint: paths.endpoint,
    token,
    versions: CONTRACT_VERSIONS,
    identity: paths.identity
  })
}

export type ProductionClientOptions = {
  entrypoint?: string
  readinessMs?: number
  spawnBroker?: (entrypoint: string) => void | Promise<void>
  paths?: LocalClientPaths
}

function defaultSpawnBroker(entrypoint: string): void {
  const child = spawn(process.execPath, [entrypoint, 'broker'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env
  })
  child.unref()
}

function brokerIsAbsent(cause: unknown): boolean {
  if (cause === null || typeof cause !== 'object') return false
  const code = (cause as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ECONNREFUSED'
}

export async function createProductionBrokerClient(
  options: ProductionClientOptions = {}
): Promise<CliBrokerClient> {
  const paths = options.paths ?? localClientPaths()
  await prepareRuntimeDirectory(paths.runtimeDirectory)
  try {
    const control = await connect(paths)
    return controlAdapter(control)
  } catch (cause) {
    if (!brokerIsAbsent(cause)) throw cause
    const rawEntrypoint = options.entrypoint ?? process.argv[1]
    if (rawEntrypoint === undefined)
      throw createComputerError(
        'provider_unavailable',
        'Cannot locate the installed CrossHands entrypoint'
      )
    const entrypoint = isAbsolute(rawEntrypoint) ? rawEntrypoint : resolve(rawEntrypoint)
    await (options.spawnBroker ?? defaultSpawnBroker)(entrypoint)
  }

  const deadline = Date.now() + (options.readinessMs ?? 2_500)
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- readiness requires ordered retries.
      const control = await connect(paths)
      return controlAdapter(control)
    } catch (cause) {
      lastError = cause
      // Polling is bounded and does not expose token or request data.
      // oxlint-disable-next-line no-await-in-loop -- readiness requires ordered retries.
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50))
    }
  }
  throw createComputerError(
    'provider_unavailable',
    'CrossHands broker did not become ready; run `crosshands computer doctor --json`',
    { cause: lastError instanceof Error ? lastError.message : 'unknown' }
  )
}

function controlAdapter(control: LocalControlClient): CliBrokerClient {
  return {
    request: async (operation, input) =>
      control.request({ operation, input }, { deadlineMs: 30_000 }),
    close: () => control.close()
  }
}
