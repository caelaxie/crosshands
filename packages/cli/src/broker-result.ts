export type BrokerResultEnvelope = {
  requestId: string
  result: unknown
  desktopEpoch: number
  providerGeneration: string
}

export function isBrokerResultEnvelope(value: unknown): value is BrokerResultEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.requestId === 'string' &&
    'result' in record &&
    typeof record.desktopEpoch === 'number' &&
    typeof record.providerGeneration === 'string'
  )
}

export function unwrapBrokerResult(value: unknown): unknown {
  return isBrokerResultEnvelope(value) ? value.result : value
}
