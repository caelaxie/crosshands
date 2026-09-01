import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  buildAndTestCurrentNative,
  cleanCurrentNativeBuild
} from '../../scripts/build-native/current.mjs'
import {
  archiveManifest,
  cleanInstallSmoke,
  currentPlatformPackage,
  extractArchive,
  inspectPack,
  packOne,
  packages,
  run,
  runPackageManager,
  sha256,
  workspaceRoot
} from '../../scripts/package/lib.mjs'

const outputDirectories: string[] = []
let packed: Awaited<ReturnType<typeof inspectPack>>[] = []

beforeAll(async () => {
  if (currentPlatformPackage === undefined)
    throw new Error(`Unsupported platform ${process.platform}`)
  const output = await mkdtemp(join(tmpdir(), 'CrossHands pack output '))
  outputDirectories.push(output)
  await buildAndTestCurrentNative()
  await runPackageManager('corepack', ['pnpm', '-r', '--if-present', 'build'], {
    cwd: workspaceRoot
  })
  const descriptors = [packages.contract, packages.runtime, packages.cli, currentPlatformPackage]
  for (const descriptor of descriptors) {
    // oxlint-disable-next-line no-await-in-loop -- avoid concurrent pnpm pack store races.
    packed.push(await packOne(descriptor, output))
  }
}, 300_000)

afterAll(async () => {
  await cleanCurrentNativeBuild()
  await Promise.all(
    outputDirectories.map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('packed package shape', () => {
  it('packs the CLI with an executable entrypoint and complete legal/readme files', () => {
    const cli = packed.find((item) => item.manifest.name === 'crosshands')
    expect(cli).toBeDefined()
    expect(cli?.entries.find((entry) => entry.path === 'dist/bin.js')?.mode[3]).toBe('x')
    expect(cli?.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['README.md', 'LICENSE', 'package.json'])
    )
  })

  it('packs the current native payload with OS constraints, assets, and notices', () => {
    const platform = packed.find((item) => item.manifest.name === currentPlatformPackage?.name)
    expect(platform).toBeDefined()
    expect(platform?.manifest.os).toContain(process.platform)
    expect(platform?.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(currentPlatformPackage?.required ?? [])
    )
  })

  it.runIf(process.platform === 'darwin')(
    'preserves the macOS helper signature and universal architectures after packing',
    async () => {
      const platform = packed.find((item) => item.manifest.name === packages.darwin.name)
      if (platform === undefined) throw new Error('macOS platform pack is missing')
      const extracted = await mkdtemp(join(tmpdir(), 'CrossHands signed extraction '))
      outputDirectories.push(extracted)
      await extractArchive(platform.archive, extracted)
      const app = join(extracted, 'package/assets/CrossHands Computer Use.app')
      const executable = join(app, 'Contents/MacOS/crosshands-computer-use-macos')
      const manifest = JSON.parse(
        await readFile(join(extracted, 'package/assets/payload.json'), 'utf8')
      )
      expect(manifest.productVersion).toBe(platform.manifest.version)
      expect(manifest.bundleIdentifier).toBe('ai.crosshands.ComputerUse')
      const releaseBuild = process.env.CROSSHANDS_RELEASE_BUILD === '1'
      expect(manifest.signing).toEqual(
        releaseBuild
          ? {
              required: true,
              authority: process.env.CROSSHANDS_CODESIGN_IDENTITY,
              teamIdentifier: process.env.CROSSHANDS_APPLE_TEAM_ID,
              notarized: true
            }
          : {
              required: false,
              authority: 'ad-hoc',
              teamIdentifier: '',
              notarized: false
            }
      )
      expect(manifest.files['crosshands-computer-use-macos']).toBe(await sha256(executable))
      await run('codesign', ['--verify', '--strict', '--verbose=2', app])
      await run('lipo', [executable, '-verify_arch', 'arm64', 'x86_64'])
    }
  )

  it('rewrites workspace dependencies to exact candidate versions', async () => {
    const cli = packed.find((item) => item.manifest.name === 'crosshands')
    if (cli === undefined) throw new Error('CLI pack is missing')
    const manifest = await archiveManifest(cli.archive)
    expect(manifest.dependencies['@crosshands/contract']).toBe(manifest.version)
    expect(manifest.dependencies['@crosshands/runtime']).toBe(manifest.version)
  })

  it('installs and imports the final tarballs from a clean path containing spaces', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'CrossHands smoke parent '))
    outputDirectories.push(parent)
    const root = await cleanInstallSmoke(packed, parent)
    await access(join(root, 'node_modules', 'crosshands', 'dist', 'index.js'))
  }, 120_000)
})
