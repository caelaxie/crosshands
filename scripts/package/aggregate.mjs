#!/usr/bin/env node

import { createPrivateKey, createPublicKey } from 'node:crypto'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createReleaseManifest,
  enrichReleaseManifest,
  inspectPack,
  packages,
  sha256,
  signerFingerprint,
  stableJson,
  validateReleaseReadyManifest,
  verifyReleaseArtifacts,
  verifyReleaseManifestSignature,
  verifyReleaseMetadata,
  writeSignedReleaseManifest
} from './lib.mjs'

const platformDescriptors = {
  darwin: packages.darwin,
  win32: packages.win32,
  linux: packages.linux
}
const commonNames = new Set([
  packages.contract.name,
  packages.runtime.name,
  packages.cli.name,
  packages.mcp.name
])
const commonSourceOrder = ['linux', 'darwin', 'win32']

function runnerWithCommonPackages(sources) {
  return commonSourceOrder
    .map((platform) => sources.find((source) => source.platform === platform))
    .find(
      (source) =>
        source !== undefined &&
        [...commonNames].every((name) =>
          source.manifest.packages.some((item) => item.name === name)
        )
    )
}

async function sourceCandidate(platform, root, publicKey) {
  const releaseDirectory = join(root, 'release')
  const packageDirectory = join(root, 'packages')
  const [manifestText, signature] = await Promise.all([
    readFile(join(releaseDirectory, 'release-manifest.json'), 'utf8'),
    readFile(join(releaseDirectory, 'release-manifest.sig'), 'utf8')
  ])
  const manifest = JSON.parse(manifestText)
  if (!verifyReleaseManifestSignature(manifest, signature.trim(), publicKey)) {
    throw new Error(`${platform} runner manifest signature is invalid`)
  }
  if (manifest.signer?.publicKeyFingerprint !== signerFingerprint(publicKey)) {
    throw new Error(`${platform} runner signer fingerprint does not match its supplied key`)
  }
  await Promise.all([
    verifyReleaseArtifacts(manifest, packageDirectory),
    verifyReleaseMetadata(manifest, releaseDirectory)
  ])
  const expected = platformDescriptors[platform].name
  if (!manifest.packages.some((item) => item.name === expected)) {
    throw new Error(`${platform} runner is missing ${expected}`)
  }
  return { platform, root, packageDirectory, manifest }
}

export function validateRunnerManifests(sources) {
  for (const [platform, descriptor] of Object.entries(platformDescriptors)) {
    const source = sources.find((item) => item.platform === platform)
    if (source === undefined) throw new Error(`Aggregate release requires the ${platform} runner`)
    if (!source.manifest.packages.some((item) => item.name === descriptor.name)) {
      throw new Error(`${platform} runner is missing ${descriptor.name}`)
    }
  }
  const versionDomains = [
    'version',
    'contractVersion',
    'controlProtocol',
    'providerProtocol',
    'mcpProtocol'
  ]
  for (const domain of versionDomains) {
    const values = new Set(sources.map((source) => source.manifest[domain]))
    if (values.size !== 1) throw new Error(`Runner manifests disagree on ${domain}`)
  }
  if (runnerWithCommonPackages(sources) === undefined) {
    throw new Error('No runner packed the common packages')
  }
}

export async function aggregateCandidates({
  runners,
  publicKeys,
  outputRoot,
  signingKey,
  requireReleaseReady = true
}) {
  for (const platform of Object.keys(platformDescriptors)) {
    if (runners[platform] === undefined || publicKeys[platform] === undefined) {
      throw new Error(`Aggregate release requires the ${platform} runner and public key`)
    }
  }
  const sources = await Promise.all(
    Object.keys(platformDescriptors).map((platform) =>
      sourceCandidate(platform, runners[platform], publicKeys[platform])
    )
  )
  validateRunnerManifests(sources)

  const selected = []
  const commonSource = runnerWithCommonPackages(sources)
  if (commonSource === undefined) throw new Error('No runner packed the common packages')
  for (const name of commonNames) {
    selected.push({
      source: commonSource,
      artifact: commonSource.manifest.packages.find((item) => item.name === name)
    })
  }
  for (const source of sources) {
    const name = platformDescriptors[source.platform].name
    selected.push({
      source,
      artifact: source.manifest.packages.find((item) => item.name === name)
    })
  }

  const packageDirectory = join(outputRoot, 'packages')
  const releaseDirectory = join(outputRoot, 'release')
  await Promise.all([
    mkdir(packageDirectory, { recursive: true }),
    mkdir(releaseDirectory, { recursive: true })
  ])
  const inspected = []
  for (const { source, artifact } of selected) {
    const sourcePath = join(source.packageDirectory, artifact.file)
    const destination = join(packageDirectory, artifact.file)
    if (resolve(sourcePath) !== resolve(destination)) {
      // oxlint-disable-next-line no-await-in-loop -- copy immutable artifacts before inspection.
      await copyFile(sourcePath, destination)
    }
    const descriptor = Object.values(packages).find((item) => item.name === artifact.name)
    if (descriptor === undefined) throw new Error(`No package descriptor for ${artifact.name}`)
    // oxlint-disable-next-line no-await-in-loop -- inspect the copied promotion input.
    inspected.push(await inspectPack(destination, descriptor))
  }
  const base = createReleaseManifest(inspected, {
    contractVersion: first.manifest.contractVersion,
    controlProtocol: first.manifest.controlProtocol,
    providerProtocol: first.manifest.providerProtocol,
    mcpProtocol: first.manifest.mcpProtocol
  })
  const evidence = Object.assign({}, ...sources.map((source) => source.manifest.platformEvidence))
  const manifest = await enrichReleaseManifest(
    base,
    inspected,
    releaseDirectory,
    signingKey,
    evidence
  )
  manifest.sourceManifests = await Promise.all(
    sources.map(async (source) => ({
      platform: source.platform,
      sha256: await sha256(join(source.root, 'release/release-manifest.json')),
      signer: source.manifest.signer.publicKeyFingerprint
    }))
  )
  if (requireReleaseReady) validateReleaseReadyManifest(manifest)
  await writeSignedReleaseManifest(releaseDirectory, manifest, signingKey)
  return manifest
}

async function main() {
  const outputRoot = resolve(process.argv[2] ?? 'artifacts')
  const runners = Object.fromEntries(
    process.argv.slice(3).map((value) => {
      const separator = value.indexOf('=')
      if (separator < 1) throw new Error(`Expected platform=artifact-directory, received ${value}`)
      return [value.slice(0, separator), resolve(value.slice(separator + 1))]
    })
  )
  const encodedKeys = process.env.CROSSHANDS_RUNNER_PUBLIC_KEYS
  const privateKey = process.env.CROSSHANDS_RELEASE_PRIVATE_KEY
  if (encodedKeys === undefined || privateKey === undefined) {
    throw new Error('CROSSHANDS_RUNNER_PUBLIC_KEYS and CROSSHANDS_RELEASE_PRIVATE_KEY are required')
  }
  const publicKeys = Object.fromEntries(
    Object.entries(JSON.parse(encodedKeys)).map(([platform, key]) => [
      platform,
      createPublicKey(key)
    ])
  )
  await aggregateCandidates({
    runners,
    publicKeys,
    outputRoot,
    signingKey: createPrivateKey(privateKey)
  })
  process.stdout.write(`${stableJson({ outputRoot })}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
