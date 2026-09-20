import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { DiagnosticRecord, DiagnosticsSink } from './record.js'

export const DEFAULT_DIAGNOSTICS_ROTATE_BYTES = 5 * 1024 * 1024

export type JsonlDiagnosticsWriterOptions = {
  directory: string
  generation: string
  maxBytes?: number
}

export class JsonlDiagnosticsWriter implements DiagnosticsSink {
  readonly directory: string
  readonly generation: string
  readonly #maxBytes: number
  #part = 1
  #started = false
  #closed = false

  constructor(options: JsonlDiagnosticsWriterOptions) {
    this.directory = options.directory
    this.generation = options.generation
    this.#maxBytes = options.maxBytes ?? DEFAULT_DIAGNOSTICS_ROTATE_BYTES
  }

  start(): void {
    if (this.#started) return
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const info = lstatSync(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('CrossHands diagnostics path is unsafe')
    }
    const uid = process.getuid?.()
    if (uid !== undefined && info.uid !== uid) {
      throw new Error('CrossHands diagnostics path has another owner')
    }
    if (process.platform !== 'win32') chmodSync(this.directory, 0o700)
    this.#started = true
  }

  emit(record: DiagnosticRecord): void {
    if (this.#closed) return
    if (!this.#started) this.start()
    const line = `${JSON.stringify(record)}\n`
    const path = this.#filePath()
    if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > this.#maxBytes) {
      this.#part += 1
    }
    appendFileSync(this.#filePath(), line, { encoding: 'utf8', mode: 0o600 })
  }

  async close(): Promise<void> {
    this.#closed = true
  }

  #filePath(): string {
    const suffix = this.#part === 1 ? '' : `.${this.#part}`
    return join(this.directory, `${this.generation}${suffix}.jsonl`)
  }
}
