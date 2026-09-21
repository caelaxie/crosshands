import { closeSync, fstatSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import { ensurePrivateDirectory } from '../private-directory.js'
import type { DiagnosticRecord, DiagnosticsSink } from './record.js'

export const DEFAULT_DIAGNOSTICS_ROTATE_BYTES = 5 * 1024 * 1024

export type JsonlFileWriterOptions = {
  directory: string
  generation: string
  maxBytes?: number
}

export class JsonlFileWriter {
  readonly directory: string
  readonly generation: string
  readonly #maxBytes: number
  #part = 1
  #started = false
  #closed = false
  #fd: number | undefined
  #bytes = 0

  constructor(options: JsonlFileWriterOptions) {
    this.directory = options.directory
    this.generation = options.generation
    this.#maxBytes = options.maxBytes ?? DEFAULT_DIAGNOSTICS_ROTATE_BYTES
  }

  start(): void {
    if (this.#started) return
    ensurePrivateDirectory(this.directory)
    this.#started = true
  }

  emit(record: Record<string, unknown>): void {
    if (this.#closed) return
    if (!this.#started) this.start()
    const line = `${JSON.stringify(record)}\n`
    const size = Buffer.byteLength(line)
    if (this.#bytes > 0 && this.#bytes + size > this.#maxBytes) this.#rotate()
    if (this.#fd === undefined) this.#open()
    const fd = this.#fd
    if (fd === undefined) return
    writeSync(fd, line)
    this.#bytes += size
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#closeFile()
  }

  #filePath(): string {
    const suffix = this.#part === 1 ? '' : `.${this.#part}`
    return join(this.directory, `${this.generation}${suffix}.jsonl`)
  }

  #open(): void {
    const fd = openSync(this.#filePath(), 'a', 0o600)
    this.#fd = fd
    this.#bytes = fstatSync(fd).size
  }

  #closeFile(): void {
    const fd = this.#fd
    this.#fd = undefined
    if (fd === undefined) return
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  #rotate(): void {
    this.#closeFile()
    this.#part += 1
  }
}

export type JsonlDiagnosticsWriterOptions = JsonlFileWriterOptions

export class JsonlDiagnosticsWriter implements DiagnosticsSink {
  readonly #file: JsonlFileWriter

  constructor(options: JsonlDiagnosticsWriterOptions) {
    this.#file = new JsonlFileWriter(options)
  }

  get directory(): string {
    return this.#file.directory
  }

  get generation(): string {
    return this.#file.generation
  }

  start(): void {
    this.#file.start()
  }

  emit(record: DiagnosticRecord): void {
    this.#file.emit(record)
  }

  close(): Promise<void> {
    return this.#file.close()
  }
}
