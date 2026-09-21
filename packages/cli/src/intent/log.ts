import { createHash, randomUUID } from 'node:crypto'

import { JsonlFileWriter, diagnosticsDirectory } from '@crosshands/runtime'

import { localClientPaths } from '../local-client.js'
import { parseJevEnv } from './env.js'

export type JevLogger = {
  emit(record: Record<string, unknown>): void
  close(): Promise<void>
}

export function hashGoal(goal: string): string {
  return createHash('sha256').update(goal).digest('hex')
}

const OMIT = new Set(['goal', 'apiKey', 'treeText', 'text', 'value', 'TYPESAFE_API_KEY'])

export function createJevLogger(
  graphicalSessionId: string,
  env: NodeJS.ProcessEnv = process.env
): JevLogger {
  const writer = new JsonlFileWriter({
    directory: diagnosticsDirectory(graphicalSessionId, { env }),
    generation: `jev-${randomUUID()}`
  })
  writer.start()
  return {
    emit(record) {
      const kind = record.kind
      if (typeof kind !== 'string') return
      const goal = record.goal
      const rest: Record<string, unknown> = { ...record, kind, v: 1, ts: new Date().toISOString() }
      for (const key of OMIT) delete rest[key]
      writer.emit({
        ...rest,
        ...(typeof goal === 'string' ? { goalSha256: hashGoal(goal) } : {})
      })
    },
    close: () => writer.close()
  }
}

export function createCliJevLogger(env: NodeJS.ProcessEnv = process.env): JevLogger | undefined {
  if (parseJevEnv(env).kind === 'off') return undefined
  return createJevLogger(localClientPaths().identity.graphicalSessionId, env)
}
