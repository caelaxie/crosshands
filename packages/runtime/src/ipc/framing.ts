export const DEFAULT_MAX_CONTROL_MESSAGE_BYTES = 1_048_576

export function encodeFrame(value: unknown, maxBytes = DEFAULT_MAX_CONTROL_MESSAGE_BYTES): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  if (payload.byteLength > maxBytes) throw new RangeError('Frame exceeds maximum message size')
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(payload.byteLength)
  return Buffer.concat([header, payload])
}

export function decodeFrames(
  buffer: Buffer,
  maxBytes = DEFAULT_MAX_CONTROL_MESSAGE_BYTES
): unknown[] {
  const frames: unknown[] = []
  let offset = 0
  while (offset < buffer.byteLength) {
    if (buffer.byteLength - offset < 4) throw new Error('Malformed incomplete frame header')
    const length = buffer.readUInt32BE(offset)
    if (length > maxBytes) throw new RangeError('Frame exceeds maximum message size')
    const end = offset + 4 + length
    if (end > buffer.byteLength) throw new Error('Malformed incomplete frame payload')
    try {
      frames.push(JSON.parse(buffer.subarray(offset + 4, end).toString('utf8')) as unknown)
    } catch {
      throw new Error('Malformed JSON frame')
    }
    offset = end
  }
  return frames
}
