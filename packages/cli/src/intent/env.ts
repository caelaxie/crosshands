export type JevEnv =
  | { kind: 'off' }
  | { kind: 'fail_closed'; reason: 'missing_key' }
  | { kind: 'on'; apiKey: string }

export function jevDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSSHANDS_JEV_DEBUG === '1'
}

export function parseJevEnv(env: NodeJS.ProcessEnv = process.env): JevEnv {
  if (env.CROSSHANDS_JEV !== '1') return { kind: 'off' }
  const apiKey = env.TYPESAFE_API_KEY
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return { kind: 'fail_closed', reason: 'missing_key' }
  }
  return { kind: 'on', apiKey }
}
