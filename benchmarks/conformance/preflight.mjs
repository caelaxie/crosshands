#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

const outputIndex = process.argv.indexOf('--output')
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined
const driver = process.env.CROSSHANDS_CONFORMANCE_DRIVER
const source = process.env.CROSSHANDS_CANDIDATE_MANIFEST
const candidate = process.env.CROSSHANDS_CANDIDATE
const matrixRole = process.env.CROSSHANDS_MATRIX_ROLE
const expectedNode = process.env.CROSSHANDS_NODE_VERSION

if (!output || !driver || !source || !candidate || !matrixRole || !expectedNode) {
  throw new Error('runner conformance environment is incomplete')
}
if (!isAbsolute(driver) || !isAbsolute(source)) {
  throw new Error('driver and candidate manifest paths must be absolute')
}
await access(driver, constants.X_OK)

const manifestBytes = await readFile(source)
const manifest = JSON.parse(manifestBytes.toString('utf8'))
const driverSha256 = createHash('sha256')
  .update(await readFile(driver))
  .digest('hex')
if (manifest.driverSha256 !== driverSha256) throw new Error('conformance driver digest mismatch')
if (manifest.releaseCandidateId !== candidate)
  throw new Error('release candidate identity mismatch')
if (manifest.matrixRole !== matrixRole) throw new Error('matrix role mismatch')
if (String(manifest.nodeVersion) !== expectedNode) throw new Error('Node baseline mismatch')

const target = resolve(output)
await mkdir(dirname(target), { recursive: true })
await writeFile(target, manifestBytes)
