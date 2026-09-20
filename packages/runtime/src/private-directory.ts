import { chmodSync, lstatSync, mkdirSync } from 'node:fs'

export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('CrossHands directory is unsafe')
  }
  const uid = process.getuid?.()
  if (uid !== undefined && info.uid !== uid) {
    throw new Error('CrossHands directory has another owner')
  }
  if (process.platform !== 'win32') chmodSync(directory, 0o700)
}
