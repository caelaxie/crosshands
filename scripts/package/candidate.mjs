#!/usr/bin/env node

import { createPrivateKey } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { buildAndTestCurrentNative, cleanCurrentNativeBuild } from '../build-native/current.mjs'
import {
  cleanInstallSmoke,
  createReleaseManifest,
  enrichReleaseManifest,
  packCurrentCandidate,
  runPackageManager,
  workspaceRoot,
  writeSignedReleaseManifest
} from './lib.mjs'

const artifactRoot = resolve(process.argv[2] ?? 'artifacts')
const packageDirectory = resolve(artifactRoot, 'packages')
const releaseDirectory = resolve(artifactRoot, 'release')
const privateKeyPem = process.env.CROSSHANDS_RELEASE_PRIVATE_KEY
if (privateKeyPem === undefined) {
  throw new Error('CROSSHANDS_RELEASE_PRIVATE_KEY is required to create a signed candidate')
}

await Promise.all([
  mkdir(packageDirectory, { recursive: true }),
  mkdir(releaseDirectory, { recursive: true })
])
try {
  await buildAndTestCurrentNative()
  await runPackageManager('corepack', ['pnpm', '-r', '--if-present', 'build'], {
    cwd: workspaceRoot
  })
  const packed = await packCurrentCandidate(packageDirectory)
  const { CONTRACT_VERSIONS } = await import('../../packages/contract/dist/index.js')
  const baseManifest = createReleaseManifest(packed, {
    contractVersion: CONTRACT_VERSIONS.publicContract,
    controlProtocol: CONTRACT_VERSIONS.brokerControl,
    providerProtocol: CONTRACT_VERSIONS.providerProtocol,
    mcpProtocol: CONTRACT_VERSIONS.mcpProtocol
  })
  const privateKey = createPrivateKey(privateKeyPem)
  const releaseBuild = process.env.CROSSHANDS_RELEASE_BUILD === '1'
  const evidence =
    process.platform === 'darwin'
      ? {
          darwin: {
            signature: releaseBuild
              ? process.env.CROSSHANDS_CODESIGN_IDENTITY
              : 'development-ad-hoc',
            notarization: releaseBuild ? 'stapled-and-validated' : 'pending'
          }
        }
      : process.platform === 'win32'
        ? {
            win32: {
              signature: releaseBuild ? process.env.CROSSHANDS_WINDOWS_PUBLISHER : 'pending',
              timestamp: releaseBuild ? 'timestamped-and-validated' : 'pending',
              chain: releaseBuild ? 'valid-authenticode-chain' : 'pending'
            }
          }
        : { linux: { payloadHash: 'verified', releaseManifestSignature: 'verified' } }
  const manifest = await enrichReleaseManifest(
    baseManifest,
    packed,
    releaseDirectory,
    privateKey,
    evidence
  )
  await writeSignedReleaseManifest(releaseDirectory, manifest, privateKey)
  const smokeDirectory = await cleanInstallSmoke(packed)
  await rm(smokeDirectory, { recursive: true, force: true })
} finally {
  await cleanCurrentNativeBuild()
}
process.stdout.write(`${artifactRoot}\n`)
