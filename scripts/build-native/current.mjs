#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { run as runCommand, workspaceRoot } from '../package/lib.mjs'

export { workspaceRoot }
const darwinApp = join(workspaceRoot, 'packages/platform-darwin/assets/CrossHands Computer Use.app')
const darwinManifest = join(workspaceRoot, 'packages/platform-darwin/assets/payload.json')

function run(command, args, options = {}) {
  return runCommand(command, args, { stdio: 'inherit', ...options })
}

async function sameBytes(left, right) {
  const [leftBytes, rightBytes] = await Promise.all([
    readFile(left),
    readFile(right).catch(() => undefined)
  ])
  return rightBytes !== undefined && leftBytes.equals(rightBytes)
}

async function syncFile(source, destination, mode) {
  await mkdir(dirname(destination), { recursive: true })
  if (!(await sameBytes(source, destination))) await copyFile(source, destination)
  await chmod(destination, mode)
}

async function packageVersion(directory) {
  const manifest = JSON.parse(
    await readFile(join(workspaceRoot, directory, 'package.json'), 'utf8')
  )
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`${directory} has no package version`)
  }
  return manifest.version
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for a CrossHands release build`)
  }
  return value
}

async function buildDarwin() {
  await run(join(workspaceRoot, 'native/macos/scripts/build-universal-app.sh'), [])
  const helper = join(darwinApp, 'Contents/MacOS/crosshands-computer-use-macos')
  const releaseBuild = process.env.CROSSHANDS_RELEASE_BUILD === '1'
  let authority = 'ad-hoc'
  let teamIdentifier = ''
  let notarized = false
  if (releaseBuild) {
    authority = requiredEnvironment('CROSSHANDS_CODESIGN_IDENTITY')
    teamIdentifier = requiredEnvironment('CROSSHANDS_APPLE_TEAM_ID')
    const appleId = requiredEnvironment('CROSSHANDS_APPLE_ID')
    const password = requiredEnvironment('CROSSHANDS_APPLE_APP_PASSWORD')
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', darwinApp])
    const staging = await mkdtemp(join(tmpdir(), 'crosshands-notary-'))
    try {
      const archive = join(staging, 'CrossHands Computer Use.zip')
      await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', darwinApp, archive])
      await run('/usr/bin/xcrun', [
        'notarytool',
        'submit',
        archive,
        '--apple-id',
        appleId,
        '--password',
        password,
        '--team-id',
        teamIdentifier,
        '--wait'
      ])
      await run('/usr/bin/xcrun', ['stapler', 'staple', darwinApp])
      await run('/usr/bin/xcrun', ['stapler', 'validate', darwinApp])
      await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', darwinApp])
      notarized = true
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  const manifest = {
    productVersion: await packageVersion('packages/platform-darwin'),
    bundleIdentifier: 'ai.crosshands.ComputerUse',
    source: 'stablyai/orca@8adfef4ff80e7817b7c7bcd6b8ddf69289078c3c',
    license: 'MIT',
    copyright: 'Copyright (c) 2026 Lovecast Inc.',
    signing: {
      required: releaseBuild,
      authority,
      teamIdentifier,
      notarized
    },
    files: {
      'crosshands-computer-use-macos': createHash('sha256')
        .update(await readFile(helper))
        .digest('hex')
    }
  }
  await writeFile(darwinManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  await run('swift', ['test', '--package-path', join(workspaceRoot, 'native/macos')])
}

async function buildLinux() {
  const source = join(workspaceRoot, 'native/linux/runtime.py')
  const destination = join(workspaceRoot, 'packages/platform-linux/assets/runtime.py')
  await syncFile(source, destination, 0o755)
  const digest = createHash('sha256')
    .update(await readFile(destination))
    .digest('hex')
  const manifest = {
    productVersion: await packageVersion('packages/platform-linux'),
    source: 'stablyai/orca@8adfef4ff80e7817b7c7bcd6b8ddf69289078c3c',
    license: 'MIT',
    copyright: 'Copyright (c) 2026 Lovecast Inc.',
    files: { 'runtime.py': digest }
  }
  await writeFile(
    join(workspaceRoot, 'packages/platform-linux/assets/payload.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 }
  )
  await run('python3', ['-m', 'unittest', 'discover', '-s', 'native/linux/tests', '-v'])
}

async function buildWindows() {
  const destination = join(workspaceRoot, 'packages/platform-windows/assets/runtime.ps1')
  const relay = join(workspaceRoot, 'packages/platform-windows/assets/crosshands-pipe-relay.exe')
  await syncFile(join(workspaceRoot, 'native/windows/runtime.ps1'), destination, 0o644)
  const executable = join(
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const releaseBuild = process.env.CROSSHANDS_RELEASE_BUILD === '1'
  const publisher = releaseBuild ? requiredEnvironment('CROSSHANDS_WINDOWS_PUBLISHER') : ''
  const thumbprint = releaseBuild
    ? requiredEnvironment('CROSSHANDS_WINDOWS_CERTIFICATE_THUMBPRINT')
    : ''
  await run(
    join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    ['/d', '/s', '/c', `"${join(workspaceRoot, 'native/windows/security/build.cmd')}"`]
  )
  if (releaseBuild) {
    const timestampUrl = requiredEnvironment('CROSSHANDS_WINDOWS_TIMESTAMP_URL')
    const signCommand = [
      '$ErrorActionPreference = "Stop"',
      '$certificate = Get-Item -LiteralPath ("Cert:\\CurrentUser\\My\\" + $env:CROSSHANDS_SIGN_THUMBPRINT)',
      'foreach ($path in ($env:CROSSHANDS_SIGN_PATHS -split [IO.Path]::PathSeparator)) {',
      '  $result = Set-AuthenticodeSignature -LiteralPath $path -Certificate $certificate -TimestampServer $env:CROSSHANDS_TIMESTAMP_URL -HashAlgorithm SHA256',
      '  if ($result.Status -ne "Valid") { throw ("Authenticode signing failed: " + $result.StatusMessage) }',
      '  if ($result.SignerCertificate.Subject -ne $env:CROSSHANDS_SIGN_PUBLISHER) { throw "Authenticode publisher mismatch" }',
      '  if ($null -eq $result.TimeStamperCertificate) { throw "Authenticode timestamp is missing" }',
      '}'
    ].join('\n')
    await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', signCommand], {
      env: {
        ...process.env,
        CROSSHANDS_SIGN_PATHS: [destination, relay].join(';'),
        CROSSHANDS_SIGN_THUMBPRINT: thumbprint,
        CROSSHANDS_SIGN_PUBLISHER: publisher,
        CROSSHANDS_TIMESTAMP_URL: timestampUrl
      }
    })
  }
  const manifest = {
    productVersion: await packageVersion('packages/platform-windows'),
    source: 'stablyai/orca@8adfef4ff80e7817b7c7bcd6b8ddf69289078c3c',
    license: 'MIT',
    copyright: 'Copyright (c) 2026 Lovecast Inc.',
    authenticode: {
      required: releaseBuild,
      publisher,
      thumbprint,
      timestampRequired: releaseBuild
    },
    files: {
      'runtime.ps1': createHash('sha256')
        .update(await readFile(destination))
        .digest('hex'),
      'crosshands-pipe-relay.exe': createHash('sha256')
        .update(await readFile(relay))
        .digest('hex')
    }
  }
  await writeFile(
    join(workspaceRoot, 'packages/platform-windows/assets/payload.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 }
  )
  await run(executable, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(workspaceRoot, 'native/windows/tests/verify-runtime.ps1')
  ])
}

export async function buildAndTestCurrentNative(platform = process.platform) {
  if (platform === 'darwin') return buildDarwin()
  if (platform === 'linux') return buildLinux()
  if (platform === 'win32') return buildWindows()
  throw new Error(`CrossHands has no native payload for ${platform}`)
}

export async function cleanCurrentNativeBuild(platform = process.platform) {
  if (platform !== 'darwin') return
  await Promise.all([
    rm(darwinApp, { recursive: true, force: true }),
    rm(darwinManifest, { force: true })
  ])
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildAndTestCurrentNative()
}
