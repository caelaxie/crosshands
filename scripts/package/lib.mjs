import { spawn } from 'node:child_process'
import { createHash, createPublicKey, sign, verify } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { create as createTar } from 'tar'

export const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const packages = Object.freeze({
  contract: {
    name: '@crosshands/contract',
    directory: 'packages/contract',
    required: ['dist/index.js', 'package.json', 'LICENSE']
  },
  runtime: {
    name: '@crosshands/runtime',
    directory: 'packages/runtime',
    required: ['dist/index.js', 'package.json', 'LICENSE']
  },
  cli: {
    name: '@crosshands/cli',
    directory: 'packages/cli',
    required: ['dist/bin.js', 'dist/index.js', 'package.json', 'README.md', 'LICENSE'],
    executable: ['dist/bin.js']
  },
  mcp: {
    name: '@crosshands/mcp',
    directory: 'packages/mcp',
    required: ['dist/bin.js', 'dist/index.js', 'package.json', 'LICENSE'],
    executable: ['dist/bin.js']
  },
  darwin: {
    name: '@crosshands/platform-darwin',
    directory: 'packages/platform-darwin',
    os: 'darwin',
    required: [
      'dist/index.js',
      'assets/CrossHands Computer Use.app/Contents/Info.plist',
      'assets/CrossHands Computer Use.app/Contents/MacOS/crosshands-computer-use-macos',
      'assets/payload.json',
      'package.json',
      'NOTICE',
      'LICENSE'
    ],
    executable: ['assets/CrossHands Computer Use.app/Contents/MacOS/crosshands-computer-use-macos']
  },
  linux: {
    name: '@crosshands/platform-linux',
    directory: 'packages/platform-linux',
    os: 'linux',
    required: [
      'dist/index.js',
      'assets/runtime.py',
      'assets/payload.json',
      'package.json',
      'README.md',
      'LICENSE'
    ],
    executable: ['assets/runtime.py']
  },
  win32: {
    name: '@crosshands/platform-windows',
    directory: 'packages/platform-windows',
    os: 'win32',
    required: [
      'dist/index.js',
      'assets/runtime.ps1',
      'assets/crosshands-pipe-relay.exe',
      'assets/payload.json',
      'package.json',
      'NOTICE.md',
      'LICENSE'
    ],
    executable: ['assets/crosshands-pipe-relay.exe']
  }
})

export const currentPlatformPackage = packages[process.platform]

export function runResult(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      ...options
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => (stdout += chunk))
    child.stderr?.on('data', (chunk) => (stderr += chunk))
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      resolveRun({
        code: code ?? 1,
        signal,
        stdout,
        stderr
      })
    })
  })
}

export async function run(command, args, options = {}) {
  const result = await runResult(command, args, options)
  if (result.code === 0) return result
  throw new Error(
    `${command} exited with ${result.code ?? result.signal ?? 'unknown status'}${result.stderr ? `: ${result.stderr.trim()}` : ''}`
  )
}

export function packageManagerInvocation(command, args, platform = process.platform) {
  if (platform !== 'win32') return { command, args }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
  return {
    command: process.env.ComSpec ?? process.env.COMSPEC ?? join(systemRoot, 'System32', 'cmd.exe'),
    args: ['/d', '/c', 'call', `${command}.cmd`, ...args]
  }
}

export function runPackageManager(command, args, options = {}) {
  const invocation = packageManagerInvocation(command, args)
  return run(invocation.command, invocation.args, options)
}

export async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function runTar(archive, beforeFile, afterFile = []) {
  return run('tar', [...beforeFile, basename(archive), ...afterFile], {
    cwd: dirname(archive)
  })
}

export async function archiveEntries(archive) {
  const { stdout } = await runTar(archive, ['-tvzf'])
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const marker = line.indexOf(' package/')
      if (marker < 0) throw new Error(`Unrecognized tar listing: ${line}`)
      return { mode: line.slice(0, 10), path: line.slice(marker + ' package/'.length) }
    })
}

export async function archiveManifest(archive) {
  const { stdout } = await runTar(archive, ['-xOzf'], ['package/package.json'])
  return JSON.parse(stdout)
}

export async function archiveTextFile(archive, path) {
  const { stdout } = await runTar(archive, ['-xOzf'], [`package/${path}`])
  return stdout
}

export async function extractArchive(archive, destination) {
  await mkdir(destination, { recursive: true })
  await runTar(archive, ['-xzf'], ['-C', destination])
}

export function assertVersionMatch(manifests) {
  const versions = new Set(manifests.map((manifest) => manifest.version))
  if (versions.size !== 1) {
    throw new Error(
      `CrossHands package versions must match exactly: ${[...versions].join(', ') || 'none'}`
    )
  }
  const [version] = versions
  if (typeof version !== 'string' || version.length === 0)
    throw new Error('Package version is empty')
  return version
}

export async function inspectPack(archive, descriptor) {
  const [entries, manifest, digest] = await Promise.all([
    archiveEntries(archive),
    archiveManifest(archive),
    sha256(archive)
  ])
  if (manifest.name !== descriptor.name) {
    throw new Error(`Expected ${descriptor.name}, packed ${String(manifest.name)}`)
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  for (const required of descriptor.required) {
    if (!byPath.has(required)) throw new Error(`${manifest.name} pack is missing ${required}`)
  }
  for (const executable of descriptor.executable ?? []) {
    const mode = byPath.get(executable)?.mode
    if (mode === undefined || mode[3] !== 'x') {
      throw new Error(`${manifest.name} packed ${executable} without its executable bit`)
    }
  }
  if (descriptor.os !== undefined && !manifest.os?.includes(descriptor.os)) {
    throw new Error(`${manifest.name} does not constrain installation to ${descriptor.os}`)
  }
  return { archive, digest, entries, manifest }
}

export async function packOne(descriptor, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true })
  const { stdout } = await runPackageManager(
    'corepack',
    [
      'pnpm',
      '--dir',
      join(workspaceRoot, descriptor.directory),
      'pack',
      '--pack-destination',
      outputDirectory,
      '--json'
    ],
    { cwd: workspaceRoot }
  )
  const packed = JSON.parse(stdout)
  if (typeof packed.filename !== 'string') throw new Error(`pnpm did not pack ${descriptor.name}`)
  const archive = resolve(packed.filename)
  if ((descriptor.executable?.length ?? 0) > 0) {
    const staging = await mkdtemp(join(tmpdir(), 'crosshands-pack-mode-'))
    try {
      await extractArchive(archive, staging)
      const executablePaths = new Set(
        descriptor.executable.map((executable) => `package/${executable}`)
      )
      await rm(archive, { force: true })
      await createTar(
        {
          cwd: staging,
          file: archive,
          gzip: true,
          portable: true,
          onWriteEntry(entry) {
            const normalizedPath = entry.path.replaceAll('\\', '/').replace(/^\.\//, '')
            if (executablePaths.has(normalizedPath)) entry.stat.mode = 0o755
          }
        },
        ['package']
      )
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  return inspectPack(archive, descriptor)
}

export const commonPackageDescriptors = Object.freeze([
  packages.contract,
  packages.runtime,
  packages.cli,
  packages.mcp
])

export async function packCurrentCandidate(outputDirectory) {
  if (currentPlatformPackage === undefined)
    throw new Error(`CrossHands does not support packaging on ${process.platform}`)
  const descriptors = [...commonPackageDescriptors, currentPlatformPackage]
  const packed = []
  for (const descriptor of descriptors) {
    // Sequential packing makes output deterministic and prevents pnpm store races on Windows.
    // oxlint-disable-next-line no-await-in-loop -- see the ordering rationale above.
    packed.push(await packOne(descriptor, outputDirectory))
  }
  assertVersionMatch(packed.map((item) => item.manifest))
  return packed
}

export function createReleaseManifest(packed, versions = {}) {
  const version = assertVersionMatch(packed.map((item) => item.manifest))
  return {
    schemaVersion: 1,
    product: 'CrossHands',
    version,
    contractVersion: versions.contractVersion ?? '1.0.0',
    controlProtocol: versions.controlProtocol ?? 1,
    providerProtocol: versions.providerProtocol ?? 1,
    mcpProtocol: versions.mcpProtocol ?? '2025-11-25',
    packages: packed
      .map((item) => ({
        name: item.manifest.name,
        version: item.manifest.version,
        file: basename(item.archive),
        sha256: item.digest,
        os: item.manifest.os ?? null,
        cpu: item.manifest.cpu ?? null
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name))
  }
}

export function signerFingerprint(key) {
  const publicKey = key?.type === 'public' ? key : createPublicKey(key)
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return `sha256:${createHash('sha256').update(der).digest('hex')}`
}

export async function enrichReleaseManifest(
  manifest,
  packed,
  releaseDirectory,
  signingKey,
  platformEvidence
) {
  const sbom = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `CrossHands-${manifest.version}`,
    documentNamespace: `https://crosshands.ai/spdx/${manifest.version}/${manifest.packages
      .map((item) => item.sha256)
      .join('-')}`,
    creationInfo: { creators: ['Tool: CrossHands packaging'], created: '1970-01-01T00:00:00Z' },
    packages: manifest.packages.map((item, index) => ({
      name: item.name,
      SPDXID: `SPDXRef-Package-${index + 1}`,
      versionInfo: item.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      checksums: [{ algorithm: 'SHA256', checksumValue: item.sha256 }],
      licenseConcluded: 'MIT',
      licenseDeclared: 'MIT'
    }))
  }
  const sbomText = `${JSON.stringify(sbom, null, 2)}\n`
  const sbomFile = 'sbom.spdx.json'
  await writeFile(join(releaseDirectory, sbomFile), sbomText, { mode: 0o644 })
  const legalNotices = []
  for (const item of packed) {
    for (const entry of item.entries) {
      if (!/(^|\/)(LICENSE|NOTICE(?:\.md)?)$/i.test(entry.path)) continue
      // oxlint-disable-next-line no-await-in-loop -- archive extraction is intentionally bounded.
      const text = await archiveTextFile(item.archive, entry.path)
      legalNotices.push({
        package: item.manifest.name,
        path: entry.path,
        sha256: createHash('sha256').update(text).digest('hex')
      })
    }
  }
  return {
    ...manifest,
    sbom: { file: sbomFile, sha256: createHash('sha256').update(sbomText).digest('hex') },
    legalNotices: legalNotices.toSorted((left, right) =>
      `${left.package}:${left.path}`.localeCompare(`${right.package}:${right.path}`)
    ),
    signer: { algorithm: 'Ed25519', publicKeyFingerprint: signerFingerprint(signingKey) },
    platformEvidence
  }
}

export async function verifyReleaseMetadata(manifest, releaseDirectory) {
  if (
    manifest.sbom === null ||
    typeof manifest.sbom !== 'object' ||
    typeof manifest.sbom.file !== 'string' ||
    typeof manifest.sbom.sha256 !== 'string'
  ) {
    throw new Error('Release manifest has no SBOM binding')
  }
  if ((await sha256(join(releaseDirectory, manifest.sbom.file))) !== manifest.sbom.sha256) {
    throw new Error('Release SBOM hash mismatch')
  }
  if (!Array.isArray(manifest.legalNotices) || manifest.legalNotices.length === 0) {
    throw new Error('Release manifest has no legal notice bindings')
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.signer?.publicKeyFingerprint ?? '')) {
    throw new Error('Release manifest has no signer fingerprint')
  }
}

export function validateReleaseReadyManifest(manifest) {
  const evidence = manifest.platformEvidence
  if (evidence === null || typeof evidence !== 'object') {
    throw new Error('Release manifest has no platform evidence')
  }
  if (/"(?:pending|required|development-ad-hoc)"/.test(JSON.stringify(evidence).toLowerCase())) {
    throw new Error('Release manifest contains pending platform evidence')
  }
  for (const [platform, fields] of Object.entries({
    darwin: ['signature', 'notarization'],
    win32: ['payloadHash', 'unsigned'],
    linux: ['payloadHash', 'releaseManifestSignature']
  })) {
    const record = evidence[platform]
    if (record === null || typeof record !== 'object') {
      throw new Error(`Release manifest has no ${platform} evidence`)
    }
    for (const field of fields) {
      if (typeof record[field] !== 'string' || record[field].length === 0) {
        throw new Error(`Release manifest has no ${platform} ${field} evidence`)
      }
    }
  }
}

export function signReleaseManifest(manifest, privateKey) {
  return sign(null, Buffer.from(stableJson(manifest)), privateKey).toString('base64')
}

export function verifyReleaseManifestSignature(manifest, signature, publicKey) {
  return verify(
    null,
    Buffer.from(stableJson(manifest)),
    publicKey,
    Buffer.from(signature, 'base64')
  )
}

export async function verifyReleaseArtifacts(manifest, directory) {
  for (const artifact of manifest.packages ?? []) {
    if (artifact.version !== manifest.version) {
      throw new Error(`${artifact.name} version does not match release ${manifest.version}`)
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error(`${artifact.name} has an invalid SHA-256 digest`)
    }
    // oxlint-disable-next-line no-await-in-loop -- report the first invalid release artifact.
    const actual = await sha256(join(directory, artifact.file))
    if (actual !== artifact.sha256) throw new Error(`${artifact.name} artifact hash mismatch`)
  }
}

export async function verifyPayloadManifest(directory, manifestName = 'payload.json') {
  const manifest = JSON.parse(await readFile(join(directory, manifestName), 'utf8'))
  if (manifest.files === null || typeof manifest.files !== 'object') {
    throw new Error('Payload manifest has no files map')
  }
  for (const [relativePath, expected] of Object.entries(manifest.files)) {
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error(`Payload manifest digest is invalid for ${relativePath}`)
    }
    // oxlint-disable-next-line no-await-in-loop -- report the first invalid payload file.
    const actual = await sha256(join(directory, relativePath))
    if (actual !== expected) throw new Error(`Payload hash mismatch for ${relativePath}`)
  }
}

export async function writeSignedReleaseManifest(directory, manifest, privateKey) {
  const signature = signReleaseManifest(manifest, privateKey)
  await Promise.all([
    writeFile(join(directory, 'release-manifest.json'), `${stableJson(manifest)}\n`, {
      mode: 0o644
    }),
    writeFile(join(directory, 'release-manifest.sig'), `${signature}\n`, { mode: 0o644 })
  ])
  return signature
}

export async function cleanInstallSmoke(packed, parentDirectory = tmpdir()) {
  const installRoot = await mkdtemp(join(parentDirectory, 'CrossHands clean install '))
  try {
    await writeFile(
      join(installRoot, 'package.json'),
      `${JSON.stringify({ name: 'crosshands-clean-install-smoke', private: true, type: 'module' })}\n`
    )
    await runPackageManager(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--omit=optional',
        '--fetch-retries=0',
        '--fetch-timeout=20000',
        ...packed.map((item) => item.archive)
      ],
      { cwd: installRoot }
    )
    const smoke = [
      "import { runCli } from '@crosshands/cli'",
      'const output = []',
      "const client = { request: async (operation) => operation === 'capabilities' ? ({ operations: { click: true } }) : ({ accessibility: 'granted' }), close: async () => {} }",
      "const code = await runCli(['computer', 'doctor', '--json'], { stdin: async () => '', stdout: (value) => output.push(value), stderr: () => {} }, client)",
      "if (code !== 0 || !output.join('').includes('readiness')) process.exit(1)"
    ].join('\n')
    await writeFile(join(installRoot, 'smoke.mjs'), `${smoke}\n`)
    await run(process.execPath, ['smoke.mjs'], { cwd: installRoot })
    await run(
      process.execPath,
      ['--check', join(installRoot, 'node_modules/@crosshands/cli/dist/bin.js')],
      {
        cwd: installRoot
      }
    )
    const bin = join(
      installRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'crosshands.cmd' : 'crosshands'
    )
    await readFile(bin)
    return installRoot
  } catch (cause) {
    await rm(installRoot, { recursive: true, force: true })
    throw cause
  }
}
