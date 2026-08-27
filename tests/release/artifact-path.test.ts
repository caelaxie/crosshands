import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  REQUIRED_RELEASE_PACKAGES,
  loadBenchmarkDefinition,
  validateReleaseArtifactPath
} from '../../benchmarks/agents/model.mjs'
import {
  sha256,
  signReleaseManifest,
  signerFingerprint,
  stableJson
} from '../../scripts/package/lib.mjs'
import { validReleaseEvidence } from './fixtures/evidence.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function artifactFixture() {
  const definition = await loadBenchmarkDefinition()
  const root = await mkdtemp(join(tmpdir(), 'CrossHands release evidence '))
  temporaryDirectories.push(root)
  const releaseDirectory = join(root, 'release')
  const packageDirectory = join(root, 'packages')
  await Promise.all([
    mkdir(releaseDirectory, { recursive: true }),
    mkdir(packageDirectory, { recursive: true })
  ])
  const packages = []
  for (const [index, name] of REQUIRED_RELEASE_PACKAGES.entries()) {
    const file = `${name.replaceAll('@', '').replaceAll('/', '-')}-0.1.0.tgz`
    const path = join(packageDirectory, file)
    // oxlint-disable-next-line no-await-in-loop -- the fixture binds each file after writing it.
    await writeFile(path, `immutable package ${index}\n`)
    // oxlint-disable-next-line no-await-in-loop -- the fixture binds each file after writing it.
    packages.push({ name, version: '0.1.0', file, sha256: await sha256(path) })
  }
  const sbomPath = join(releaseDirectory, 'sbom.spdx.json')
  await writeFile(sbomPath, '{"spdxVersion":"SPDX-2.3"}\n')
  const legalNotices = packages.map((item, index) => ({
    package: item.name,
    path: 'LICENSE',
    sha256: `${index}`.repeat(64)
  }))
  const keys = generateKeyPairSync('ed25519')
  const manifest = {
    schemaVersion: 1,
    product: 'CrossHands',
    version: '0.1.0',
    packages,
    sbom: { file: 'sbom.spdx.json', sha256: await sha256(sbomPath) },
    legalNotices,
    signer: {
      algorithm: 'Ed25519',
      publicKeyFingerprint: signerFingerprint(keys.publicKey)
    },
    platformEvidence: {
      darwin: { signature: 'Developer ID', notarization: 'ticket' },
      win32: { payloadHash: 'verified', unsigned: 'unsigned-payload' },
      linux: { payloadHash: 'verified', releaseManifestSignature: 'verified' }
    }
  }
  const manifestText = `${stableJson(manifest)}\n`
  const manifestPath = join(releaseDirectory, 'release-manifest.json')
  await writeFile(manifestPath, manifestText)
  await writeFile(
    join(releaseDirectory, 'release-manifest.sig'),
    `${signReleaseManifest(manifest, keys.privateKey)}\n`
  )
  const evidence = validReleaseEvidence(definition, {
    packages,
    legalNotices,
    releaseManifestSha256: await sha256(manifestPath),
    signerFingerprint: signerFingerprint(keys.publicKey),
    sbomSha256: await sha256(sbomPath)
  })
  evidence.signatures.releaseManifest.signature = (
    await readFile(join(releaseDirectory, 'release-manifest.sig'), 'utf8')
  ).trim()
  return { definition, root, keys, evidence, packageDirectory, packages }
}

describe('final artifact release validation', () => {
  it('cryptographically validates the supplied artifacts/release path and package bytes', async () => {
    const fixture = await artifactFixture()
    await expect(
      validateReleaseArtifactPath(fixture.evidence, fixture.definition, {
        artifactsRoot: fixture.root,
        releasePublicKey: fixture.keys.publicKey
      })
    ).resolves.toMatchObject({ product: 'CrossHands', version: '0.1.0' })
  })

  it('rejects a modified package and a missing manifest verification key', async () => {
    const fixture = await artifactFixture()
    await expect(
      validateReleaseArtifactPath(fixture.evidence, fixture.definition, {
        artifactsRoot: fixture.root,
        releasePublicKey: undefined
      })
    ).rejects.toThrow(/releasePublicKey is required/)

    await writeFile(join(fixture.packageDirectory, fixture.packages[0]!.file), 'tampered\n')
    await expect(
      validateReleaseArtifactPath(fixture.evidence, fixture.definition, {
        artifactsRoot: fixture.root,
        releasePublicKey: fixture.keys.publicKey
      })
    ).rejects.toThrow(/artifact hash mismatch/)
  })
})
