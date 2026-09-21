export type JevHttpStats = {
  status: number
  durationMs: number
  requestBytes: number
  responseBytes: number
}

export function elapsedMs(started: number): number {
  return Math.max(0, Date.now() - started)
}
