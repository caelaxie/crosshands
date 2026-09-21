export type BrokerResultEnvelope = {
  requestId: string
  result: unknown
}

export function isBrokerResultEnvelope(value: unknown): value is BrokerResultEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.requestId === 'string' && 'result' in record
}

export function unwrapBrokerResult(value: unknown): unknown {
  return isBrokerResultEnvelope(value) ? value.result : value
}
