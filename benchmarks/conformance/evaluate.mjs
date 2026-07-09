#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFORMANCE_CATALOG, digest, evaluateConformance } from './model.ts'

const RELEASE_CELLS = {
  'macos-14-arm64': { id: 'macos14-arm64', platform: 'darwin' },
  'macos-14-x64': { id: 'macos14-x64', platform: 'darwin' },
  'macos-26-arm64': { id: 'macos26-arm64', platform: 'darwin' },
  'windows-10-x64': { id: 'windows10-x64', platform: 'win32' },
  'windows-11-current-x64': { id: 'windows11-current-x64', platform: 'win32' },
  'ubuntu-24.04-x64': { id: 'ubuntu2404-xorg-x64', platform: 'linux' }
}

function hexDigest(value) {
  return digest(value).slice('sha256:'.length)
}

function assertSame(manifests, field, role) {
  const values = manifests.map((manifest) => digest(manifest[field] ?? null))
  if (new Set(values).size !== 1) throw new Error(`${role} Node cells disagree on ${field}`)
  return manifests[0][field]
}

export async function loadConformanceEvidence(root) {
  const entries = await readdir(root, { recursive: true })
  const loaded = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry)
      if (entry.endsWith('manifest.json')) {
        return { manifest: JSON.parse(await readFile(path, 'utf8')) }
      }
      if (entry.endsWith('runs.jsonl')) {
        const lines = (await readFile(path, 'utf8')).trim().split(/\r?\n/).filter(Boolean)
        return { records: lines.map((line) => JSON.parse(line)) }
      }
      return {}
    })
  )
  return {
    manifests: loaded.flatMap(({ manifest }) => (manifest ? [manifest] : [])),
    records: loaded.flatMap(({ records }) => records ?? [])
  }
}

export function aggregateConformance(manifests, records, catalog = CONFORMANCE_CATALOG) {
  const evaluation = evaluateConformance(manifests, records, catalog)
  if (!evaluation.accepted) {
    throw new Error(`conformance rejected:\n${JSON.stringify(evaluation.failures, null, 2)}`)
  }

  const releaseCandidateIds = new Set(manifests.map(({ releaseCandidateId }) => releaseCandidateId))
  if (releaseCandidateIds.size !== 1) throw new Error('matrix cells reference different candidates')
  const packageSets = new Set(
    manifests.map(({ candidatePackageSetSha256 }) => candidatePackageSetSha256)
  )
  if (packageSets.size !== 1) throw new Error('matrix cells reference different package sets')
  const recordsByCandidate = new Map()
  const recordsByCandidateTaskAdapter = new Map()
  for (const record of records) {
    const candidateRecords = recordsByCandidate.get(record.candidateId) ?? []
    candidateRecords.push(record)
    recordsByCandidate.set(record.candidateId, candidateRecords)
    const key = `${record.candidateId}\u0000${record.taskId}\u0000${record.adapter}`
    const scopedRecords = recordsByCandidateTaskAdapter.get(key) ?? []
    scopedRecords.push(record)
    recordsByCandidateTaskAdapter.set(key, scopedRecords)
  }

  const cells = Object.entries(RELEASE_CELLS).map(([role, releaseCell]) => {
    const roleManifests = manifests.filter((manifest) => manifest.matrixRole === role)
    if (roleManifests.length !== 2) throw new Error(`${role} must contain Node 22 and Node 24`)
    const byNode = new Map(roleManifests.map((manifest) => [manifest.nodeVersion, manifest]))
    if (!byNode.has('22') || !byNode.has('24')) {
      throw new Error(`${role} must contain Node 22 and Node 24`)
    }

    for (const field of [
      'releaseCandidateId',
      'platform',
      'osVersion',
      'osBuild',
      'matrixAdjudication',
      'architecture',
      'desktopSession',
      'displayLayout',
      'locale',
      'ime',
      'fixtureVersion',
      'fixtureResetDigest',
      'permissionBaseline',
      'runnerImageSha256',
      'runnerBaselineSha256',
      'candidatePackageSetSha256',
      'packageDigests',
      'signerFingerprints'
    ]) {
      assertSame(roleManifests, field, role)
    }

    const roleRecords = roleManifests.flatMap(
      ({ candidateId }) => recordsByCandidate.get(candidateId) ?? []
    )
    const tasks = catalog.tasks.map(({ id: taskId }) => {
      const taskRecords = roleRecords.filter((record) => record.taskId === taskId)
      const adapterNodeResults = roleManifests.flatMap((manifest) =>
        catalog.adapters.map((adapter) => {
          const scoped =
            recordsByCandidateTaskAdapter.get(
              `${manifest.candidateId}\u0000${taskId}\u0000${adapter}`
            ) ?? []
          const terminal = scoped.filter(
            (record) => record.classification !== 'infrastructure-invalidated'
          )
          const passed = terminal.filter((record) => record.classification === 'pass').length
          return {
            node: manifest.nodeVersion,
            adapter,
            passed,
            productFailures: catalog.repetitions - passed,
            infrastructureFailures: scoped.length - terminal.length,
            recordsSha256: hexDigest(
              scoped.toSorted((left, right) => left.runId.localeCompare(right.runId))
            )
          }
        })
      )
      const passed = Math.min(...adapterNodeResults.map((result) => result.passed))
      const invalidated = taskRecords.filter(
        (record) => record.classification === 'infrastructure-invalidated'
      )
      const infrastructureCounts = new Map()
      for (const record of invalidated) {
        if (!record.infrastructureCode) continue
        infrastructureCounts.set(
          record.infrastructureCode,
          (infrastructureCounts.get(record.infrastructureCode) ?? 0) + 1
        )
      }
      const infrastructureByCode = Object.fromEntries(
        [...infrastructureCounts.entries()].toSorted(([left], [right]) => left.localeCompare(right))
      )
      return {
        taskId,
        denominator: catalog.repetitions,
        passed,
        productFailures: catalog.repetitions - passed,
        infrastructureFailures: invalidated.length,
        infrastructureByCode,
        automaticRetries: 0,
        recordsSha256: hexDigest(
          taskRecords.toSorted((left, right) => left.runId.localeCompare(right.runId))
        ),
        adapterNodeResults
      }
    })

    const manifest = roleManifests[0]
    const invalidatedRuns = roleRecords.filter(
      (record) => record.classification === 'infrastructure-invalidated'
    )
    return {
      id: releaseCell.id,
      matrixRole: role,
      platform: releaseCell.platform,
      architecture: manifest.architecture,
      osVersion: manifest.osVersion,
      osBuild: manifest.osBuild,
      ...(manifest.matrixAdjudication ? { matrixAdjudication: manifest.matrixAdjudication } : {}),
      desktop: manifest.desktopSession,
      runnerImageSha256: manifest.runnerImageSha256,
      runnerBaselineSha256: manifest.runnerBaselineSha256,
      candidatePackageSetSha256: manifest.candidatePackageSetSha256,
      packageDigests: manifest.packageDigests,
      signerFingerprints: manifest.signerFingerprints,
      runner: {
        displayLayout: manifest.displayLayout,
        locale: manifest.locale,
        ime: manifest.ime,
        permissionBaseline: manifest.permissionBaseline,
        fixtureResetDigest: manifest.fixtureResetDigest
      },
      nodeGates: ['22', '24'].map((node) => ({ node, package: true, cli: true, mcp: true })),
      tasks,
      invalidatedRuns: invalidatedRuns.map((record) => ({
        runId: record.runId,
        taskId: record.taskId,
        adapter: record.adapter,
        node: roleManifests.find(({ candidateId }) => candidateId === record.candidateId)
          ?.nodeVersion,
        infrastructureCode: record.infrastructureCode,
        runnerEvidenceSha256: hexDigest(record.runnerEvidence),
        recordSha256: hexDigest(record)
      })),
      invalidatedRunsSha256: hexDigest(
        invalidatedRuns.toSorted((left, right) => left.runId.localeCompare(right.runId))
      ),
      exclusions: []
    }
  })

  return {
    schemaVersion: 1,
    releaseCandidateId: [...releaseCandidateIds][0],
    fixtureVersion: catalog.fixtureVersion,
    generatedAt: new Date().toISOString(),
    conformance: {
      catalogVersion: catalog.catalogVersion,
      catalogDigest: hexDigest(catalog),
      cells
    }
  }
}

async function main() {
  const evidenceIndex = process.argv.indexOf('--evidence')
  const outputIndex = process.argv.indexOf('--output')
  const evidenceRoot = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined
  if (!evidenceRoot || !output) {
    throw new Error(
      'usage: evaluate.mjs --evidence <directory> --output <conformance-evidence.json>'
    )
  }
  const loaded = await loadConformanceEvidence(resolve(evidenceRoot))
  const aggregate = aggregateConformance(loaded.manifests, loaded.records)
  const target = resolve(output)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(aggregate, null, 2)}\n`, { mode: 0o600 })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main()
}
