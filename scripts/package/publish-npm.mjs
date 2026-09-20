#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { archiveManifest, packages, run, workspaceRoot } from './lib.mjs'

export const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org'
const CLI_PACKAGE = packages.cli.name

export function npmDistTag(version) {
  return version.includes('-') ? 'next' : 'latest'
}

export function publishOrder(archives) {
  const payloads = archives.filter((item) => item.name !== CLI_PACKAGE)
  const mainPackage = archives.filter((item) => item.name === CLI_PACKAGE)
  if (mainPackage.length !== 1) {
    throw new Error(`npm publish requires exactly one ${CLI_PACKAGE} archive`)
  }
  return [
    ...payloads.toSorted((left, right) => left.name.localeCompare(right.name)),
    ...mainPackage
  ]
}

async function npmView(name, version, field, registry) {
  const result = await run('npm', ['view', `${name}@${version}`, field, '--registry', registry], {
    cwd: workspaceRoot
  }).catch(() => null)
  const value = result?.stdout.trim() ?? ''
  return value.length > 0 ? value : null
}

export async function planNpmPublish(archives, options = {}) {
  const registry = options.registry ?? PUBLIC_NPM_REGISTRY
  const tag = options.tag ?? npmDistTag(archives[0]?.version ?? '')
  const planned = []
  for (const item of publishOrder(archives)) {
    // oxlint-disable-next-line no-await-in-loop -- registry lookups stay ordered with publish.
    const existing = await npmView(item.name, item.version, 'version', registry)
    if (existing === null) {
      planned.push({ ...item, action: 'publish', tag, registry })
      continue
    }
    const local = options.integrity?.(item) ?? item.integrity
    // oxlint-disable-next-line no-await-in-loop -- compare local bytes to the existing registry object.
    const remote = await npmView(item.name, item.version, 'dist.integrity', registry)
    if (local !== remote) {
      throw new Error(
        `Refusing to publish ${item.name}@${item.version}: registry integrity differs`
      )
    }
    planned.push({ ...item, action: 'dist-tag', tag, registry })
  }
  return planned
}

export async function loadPackedArchives(directory) {
  const root = resolve(directory)
  const files = (await readdir(root)).filter((name) => name.endsWith('.tgz')).toSorted()
  if (files.length === 0) throw new Error(`No package tarballs in ${root}`)
  const archives = []
  for (const file of files) {
    const archive = join(root, file)
    // oxlint-disable-next-line no-await-in-loop -- inspect each tarball before publish.
    const manifest = await archiveManifest(archive)
    // oxlint-disable-next-line no-await-in-loop -- hash the same archive the manifest came from.
    const bytes = await readFile(archive)
    const digest = createHash('sha512').update(bytes).digest('base64')
    archives.push({
      archive,
      file,
      name: manifest.name,
      version: manifest.version,
      integrity: `sha512-${digest}`
    })
  }
  return archives
}

async function executePlan(plan, options = {}) {
  for (const item of plan) {
    if (item.action === 'dist-tag') {
      if (options.dryRun === true) {
        process.stdout.write(`dry-run dist-tag add ${item.name}@${item.version} ${item.tag}\n`)
        continue
      }
      // oxlint-disable-next-line no-await-in-loop -- publish payloads before the main package.
      await run(
        'npm',
        ['dist-tag', 'add', `${item.name}@${item.version}`, item.tag, '--registry', item.registry],
        { cwd: workspaceRoot }
      )
      continue
    }
    const args = [
      'publish',
      item.archive,
      '--registry',
      item.registry,
      '--tag',
      item.tag,
      '--access',
      'public'
    ]
    if (options.dryRun === true) args.push('--dry-run')
    // oxlint-disable-next-line no-await-in-loop -- publish payloads before the main package.
    await run('npm', args, { cwd: workspaceRoot })
    process.stdout.write(`published ${item.name}@${item.version} as ${item.tag}\n`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const directory = resolve(
    args.find((value) => value !== '--dry-run') ?? join(workspaceRoot, 'artifacts/packages')
  )
  const archives = await loadPackedArchives(directory)
  const version = archives[0]?.version
  if (archives.some((item) => item.version !== version)) {
    throw new Error('Packed versions must match before npm publish')
  }
  const plan = await planNpmPublish(archives, {
    registry: process.env.NPM_REGISTRY_URL ?? PUBLIC_NPM_REGISTRY,
    tag: process.env.NPM_DIST_TAG ?? npmDistTag(version)
  })
  await executePlan(plan, { dryRun })
  process.stdout.write(
    `${plan.length} packages processed from ${basename(directory)} (${dryRun ? 'dry-run' : 'publish'})\n`
  )
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  await main()
}
