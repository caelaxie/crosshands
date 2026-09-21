import { randomUUID } from 'node:crypto'

import { JsonlDiagnosticsWriter, diagnosticsDirectory } from '@crosshands/runtime'

import { hashGoal } from './env.js'

export type JevLogger = {
  emit(record: Record<string, unknown>): void
  close(): Promise<void>
}

export function createJevLogger(
  graphicalSessionId: string,
  env: NodeJS.ProcessEnv = process.env
): JevLogger {
  const writer = new JsonlDiagnosticsWriter({
    directory: diagnosticsDirectory(graphicalSessionId, { env }),
    generation: `jev-${randomUUID()}`
  })
  writer.start()
  return {
    emit(record) {
      const kind = record.kind
      if (typeof kind !== 'string') return
      const goal = record.goal
      const rest = { ...record }
      delete rest.goal
      writer.emit({
        ...rest,
        kind,
        v: 1,
        ts: new Date().toISOString(),
        ...(typeof goal === 'string' ? { goalSha256: hashGoal(goal) } : {})
      })
    },
    close: () => writer.close()
  }
}
