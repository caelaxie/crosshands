import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  assertVersionMatch,
  createReleaseManifest,
  sha256,
  signReleaseManifest,
  signerFingerprint,
  validateReleaseReadyManifest,
  verifyPayloadManifest,
  verifyReleaseArtifacts,
  verifyReleaseManifestSignature
} from '../../scripts/package/lib.mjs'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'CrossHands packaging test '))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('release artifact integrity', () => {
  it('signs stable manifest bytes and rejects any post-signing change', () => {
    const keys = generateKeyPairSync('ed25519')
    const packed = [
      {
        archive: '/candidate/crosshands-cli-0.1.0.tgz',
        digest: 'a'.repeat(64),
        manifest: { name: '@crosshands/cli', version: '0.1.0' }
      }
    ]
    const manifest = createReleaseManifest(packed)
    const signature = signReleaseManifest(manifest, keys.privateKey)
    expect(verifyReleaseManifestSignature(manifest, signature, keys.publicKey)).toBe(true)
    expect(
      verifyReleaseManifestSignature({ ...manifest, version: '0.1.1' }, signature, keys.publicKey)
    ).toBe(false)
    expect(signerFingerprint(keys.privateKey)).toBe(signerFingerprint(keys.publicKey))
  })

  it('rejects pending or incomplete platform evidence before promotion', () => {
    const complete = {
      platformEvidence: {
        darwin: { signature: 'Developer ID Application: CrossHands', notarization: 'ticket-1' },
        win32: { payloadHash: 'verified', unsigned: 'unsigned-payload' },
        linux: { payloadHash: 'verified', releaseManifestSignature: 'verified' }
      }
    }
    expect(() => validateReleaseReadyManifest(complete)).not.toThrow()
    expect(() =>
      validateReleaseReadyManifest({
        ...complete,
        platformEvidence: {
          ...complete.platformEvidence,
          darwin: { signature: 'development-ad-hoc', notarization: 'pending' }
        }
      })
    ).toThrow(/pending platform evidence/)
    expect(() =>
      validateReleaseReadyManifest({
        ...complete,
        platformEvidence: { ...complete.platformEvidence, win32: { payloadHash: 'verified' } }
      })
    ).toThrow(/win32 unsigned/)
  })

  it('rejects mixed package versions before producing a candidate', () => {
    expect(() =>
      assertVersionMatch([
        { name: '@crosshands/cli', version: '0.1.0' },
        { name: '@crosshands/platform-darwin', version: '0.1.1' }
      ])
    ).toThrow(/must match exactly/)
  })

  it('detects tampered package archives and payload files', async () => {
    const directory = await temporaryDirectory()
    const archive = join(directory, 'crosshands-cli-0.1.0.tgz')
    await writeFile(archive, 'original package bytes')
    const digest = await sha256(archive)
    const release = {
      version: '0.1.0',
      packages: [
        {
          name: '@crosshands/cli',
          version: '0.1.0',
          file: 'crosshands-cli-0.1.0.tgz',
          sha256: digest
        }
      ]
    }
    await expect(verifyReleaseArtifacts(release, directory)).resolves.toBeUndefined()
    await writeFile(archive, 'modified package bytes')
    await expect(verifyReleaseArtifacts(release, directory)).rejects.toThrow(
      /artifact hash mismatch/
    )

    const runtime = join(directory, 'runtime.py')
    await writeFile(runtime, '#!/usr/bin/env python3\n')
    await chmod(runtime, 0o755)
    await writeFile(
      join(directory, 'payload.json'),
      JSON.stringify({ files: { 'runtime.py': await sha256(runtime) } })
    )
    await expect(verifyPayloadManifest(directory)).resolves.toBeUndefined()
    await writeFile(runtime, '# tampered\n')
    await expect(verifyPayloadManifest(directory)).rejects.toThrow(/Payload hash mismatch/)
  })

  it('keeps the repository Linux payload manifest synchronized', async () => {
    const directory = join(process.cwd(), 'packages/platform-linux/assets')
    const manifest = JSON.parse(await readFile(join(directory, 'payload.json'), 'utf8'))
    expect(manifest.files['runtime.py']).toMatch(/^[a-f0-9]{64}$/)
    await expect(verifyPayloadManifest(directory)).resolves.toBeUndefined()
  })
})
