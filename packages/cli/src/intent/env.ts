import { createHash } from 'node:crypto'

import { createComputerError } from '@crosshands/contract'

export type JevEnv =
  | { kind: 'off' }
  | { kind: 'fail_closed'; reason: 'missing_key' }
  | { kind: 'on'; apiKey: string }

export function parseJevEnv(env: NodeJS.ProcessEnv = process.env): JevEnv {
  if (env.CROSSHANDS_JEV !== '1') return { kind: 'off' }
  const apiKey = env.TYPESAFE_API_KEY
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return { kind: 'fail_closed', reason: 'missing_key' }
  }
  return { kind: 'on', apiKey }
}

export function brokerSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env }
  delete next.CROSSHANDS_JEV
  for (const key of Object.keys(next)) {
    if (key === 'TYPESAFE_API_KEY' || key.startsWith('TYPESAFE_')) delete next[key]
  }
  return next
}

export function hashGoal(goal: string): string {
  return createHash('sha256').update(goal).digest('hex')
}

export function intentUnavailable(message: string): never {
  throw createComputerError('intent_unavailable', message)
}
