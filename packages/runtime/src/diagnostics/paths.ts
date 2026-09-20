import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { InstalledResource } from '../bundle-lifecycle.js'

export function graphicalSessionKey(graphicalSessionId: string): string {
  return createHash('sha256').update(graphicalSessionId).digest('hex').slice(0, 12)
}

export function diagnosticsDirectory(
  graphicalSessionId: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}
): string {
  const env = options.env ?? process.env
  const override = env.CROSSHANDS_DIAGNOSTICS_DIR
  if (typeof override === 'string' && override.length > 0) return override
  const sessionKey = graphicalSessionKey(graphicalSessionId)
  const platform = options.platform ?? process.platform
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Logs', 'CrossHands', sessionKey)
  }
  if (platform === 'linux') {
    const stateHome =
      typeof env.XDG_STATE_HOME === 'string' && env.XDG_STATE_HOME.length > 0
        ? env.XDG_STATE_HOME
        : join(homedir(), '.local', 'state')
    return join(stateHome, 'crosshands', sessionKey)
  }
  const localAppData =
    typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.length > 0
      ? env.LOCALAPPDATA
      : join(homedir(), 'AppData', 'Local')
  return join(localAppData, 'CrossHands', 'logs', sessionKey)
}

export function diagnosticsResource(directory: string): InstalledResource {
  return { id: directory, kind: 'log', owner: 'crosshands' }
}
