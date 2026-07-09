#!/usr/bin/env node

import { readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  archiveManifest,
  assertVersionMatch,
  cleanInstallSmoke,
  currentPlatformPackage,
  inspectPack,
  packages
} from './lib.mjs'

export async function smokeExistingArtifacts(artifactRoot) {
  if (currentPlatformPackage === undefined) {
    throw new Error(`CrossHands has no package smoke definition for ${process.platform}`)
  }
  const packageDirectory = join(artifactRoot, 'packages')
  const files = (await readdir(packageDirectory)).filter((file) => file.endsWith('.tgz'))
  const descriptors = new Map(
    Object.values(packages).map((descriptor) => [descriptor.name, descriptor])
  )
  const inspected = []
  for (const file of files) {
    const archive = join(packageDirectory, file)
    // oxlint-disable-next-line no-await-in-loop -- inspect bounded final artifacts in order.
    const manifest = await archiveManifest(archive)
    const descriptor = descriptors.get(manifest.name)
    if (descriptor === undefined) throw new Error(`Unknown CrossHands package ${manifest.name}`)
    // oxlint-disable-next-line no-await-in-loop -- inspection must complete before selection.
    inspected.push(await inspectPack(archive, descriptor))
  }
  const required = [
    packages.contract,
    packages.runtime,
    packages.cli,
    packages.mcp,
    currentPlatformPackage
  ]
  const selected = required.map((descriptor) => {
    const item = inspected.find((candidate) => candidate.manifest.name === descriptor.name)
    if (item === undefined) throw new Error(`Artifact set is missing ${descriptor.name}`)
    return item
  })
  assertVersionMatch(selected.map((item) => item.manifest))
  const smokeDirectory = await cleanInstallSmoke(selected)
  await rm(smokeDirectory, { recursive: true, force: true })
  return selected
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await smokeExistingArtifacts(resolve(process.argv[2] ?? 'artifacts'))
}
