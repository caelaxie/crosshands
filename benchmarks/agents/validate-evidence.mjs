import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import {
  loadBenchmarkDefinition,
  mergeAgentEvidenceFragments,
  validateReleaseArtifactPath,
  validateReleaseEvidence
} from './model.mjs'

function option(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function jsonFiles(directory) {
  const entries = await readdir(directory, { recursive: true })
  return entries
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => join(directory, entry))
    .toSorted()
}

const definition = await loadBenchmarkDefinition()
const fragmentDirectory = option('--fragments')
const releaseEvidencePath = option('--release-evidence')

if (fragmentDirectory !== undefined) {
  const fragments = await Promise.all(
    (await jsonFiles(resolve(fragmentDirectory))).map(async (path) =>
      JSON.parse(await readFile(path, 'utf8'))
    )
  )
  const evidence = mergeAgentEvidenceFragments(fragments, definition)
  const output = resolve(option('--output') ?? 'artifacts/evidence/agent-evidence.json')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ valid: true, output })}\n`)
} else if (releaseEvidencePath !== undefined) {
  const evidence = JSON.parse(await readFile(resolve(releaseEvidencePath), 'utf8'))
  const artifactsRoot = option('--artifacts')
  const publicKeyPath = option('--public-key')
  if (artifactsRoot === undefined) validateReleaseEvidence(evidence, definition)
  else {
    if (publicKeyPath === undefined) throw new Error('--public-key is required with --artifacts')
    await validateReleaseArtifactPath(evidence, definition, {
      artifactsRoot: resolve(artifactsRoot),
      releasePublicKey: await readFile(resolve(publicKeyPath), 'utf8')
    })
  }
  process.stdout.write(`${JSON.stringify({ valid: true })}\n`)
} else {
  throw new Error('Use --fragments <directory> or --release-evidence <file>')
}
