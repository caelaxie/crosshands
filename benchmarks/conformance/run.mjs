#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { validateDriverResponse } from './driver-response.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((entries, value, index, values) => {
    if (value.startsWith('--') && values[index + 1] && !values[index + 1].startsWith('--')) {
      entries.push([value.slice(2), values[index + 1]])
    }
    return entries
  }, [])
)

const driver = args.driver ?? process.env.CROSSHANDS_CONFORMANCE_DRIVER
if (!args.manifest || !args.output || !driver) {
  throw new Error(
    'usage: run.mjs --manifest <json> --output <jsonl> [--driver <absolute executable>]'
  )
}
if (!isAbsolute(driver)) throw new Error('the conformance driver path must be absolute')
await access(driver, constants.X_OK)

const catalog = JSON.parse(await readFile(new URL('./catalog.v1.json', import.meta.url), 'utf8'))
const manifest = JSON.parse(await readFile(resolve(args.manifest), 'utf8'))
const driverSha256 = createHash('sha256')
  .update(await readFile(driver))
  .digest('hex')
if (driverSha256 !== manifest.driverSha256) {
  throw new Error('the conformance driver digest differs from the reviewed candidate manifest')
}
const output = resolve(args.output)
await mkdir(dirname(output), { recursive: true })

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const catalogDigest = `sha256:${createHash('sha256').update(stableJson(catalog)).digest('hex')}`
const driverEnvironment = Object.fromEntries(
  [
    'PATH',
    'HOME',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'XDG_SESSION_ID',
    'XDG_SESSION_TYPE',
    'DBUS_SESSION_BUS_ADDRESS',
    'SECURITYSESSIONID',
    'LOCALAPPDATA',
    'USERPROFILE',
    'SESSIONNAME',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP'
  ].flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]]))
)
const cellId = [
  manifest.matrixRole,
  manifest.osBuild,
  manifest.architecture,
  `node${manifest.nodeVersion}`,
  manifest.desktopSession,
  manifest.locale,
  manifest.ime,
  catalogDigest.slice(-12)
].join(':')

for (const task of catalog.tasks) {
  for (const adapter of catalog.adapters) {
    for (let repetition = 1; repetition <= catalog.repetitions; repetition += 1) {
      let terminal = false
      for (let attempt = 1; attempt <= 4 && !terminal; attempt += 1) {
        const request = {
          schemaVersion: 'crosshands.conformance-driver-request/v1',
          candidateId: manifest.candidateId,
          catalogDigest,
          fixtureVersion: catalog.fixtureVersion,
          cellId,
          task,
          adapter,
          repetition,
          attempt,
          fixtureResetDigest: manifest.fixtureResetDigest,
          driverSha256
        }
        const startedAt = new Date().toISOString()
        const started = performance.now()
        const result = spawnSync(driver, ['run'], {
          input: `${JSON.stringify(request)}\n`,
          encoding: 'utf8',
          env: { ...driverEnvironment, CROSSHANDS_CONFORMANCE: '1' },
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true
        })
        if (result.error || result.status !== 0) {
          throw new Error(
            `driver failed before producing evidence for ${task.id}/${adapter}/${repetition}: ${result.error?.message ?? `exit ${result.status}`}`
          )
        }
        const lines = result.stdout.trim().split(/\r?\n/)
        if (lines.length !== 1)
          throw new Error('driver stdout must contain exactly one JSON response')
        const response = validateDriverResponse(JSON.parse(lines[0]), catalog)
        const record = {
          ...response,
          schemaVersion: 'crosshands.conformance-run/v1',
          runId: `${manifest.candidateId}:${task.id}:${adapter}:${repetition}:${attempt}`,
          candidateId: manifest.candidateId,
          catalogDigest,
          fixtureVersion: catalog.fixtureVersion,
          platform: manifest.platform,
          cellId,
          taskId: task.id,
          adapter,
          repetition,
          attempt,
          startedAt,
          durationMs: Math.round(performance.now() - started),
          fixtureResetDigest: manifest.fixtureResetDigest
        }
        // Benchmark attempts intentionally serialize access to the single desktop session.
        // eslint-disable-next-line no-await-in-loop
        await appendFile(output, `${JSON.stringify(record)}\n`, { mode: 0o600 })
        terminal = record.classification !== 'infrastructure-invalidated'
      }
      if (!terminal) {
        throw new Error(
          `infrastructure invalidated four attempts for ${task.id}/${adapter}/${repetition}`
        )
      }
    }
  }
}
