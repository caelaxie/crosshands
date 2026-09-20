#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

const PRODUCT_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$/
const PINNED_VERSION_PATTERN = '[0-9]+\\.[0-9]+\\.[0-9]+(?:[+-][0-9A-Za-z.-]+)?'
const AGENT_CATALOG = 'benchmarks/agents/catalog.json'
const JS_PRODUCT = /^(\s*product:\s*')([^']+)(')/m

export const VERSION_SITES = Object.freeze([
  Object.freeze({ kind: 'package-json', path: 'packages/cli/package.json' }),
  Object.freeze({ kind: 'package-json', path: 'packages/contract/package.json' }),
  Object.freeze({ kind: 'package-json', path: 'packages/mcp/package.json' }),
  Object.freeze({ kind: 'package-json', path: 'packages/runtime/package.json' }),
  Object.freeze({ kind: 'package-json', path: 'packages/provider-testkit/package.json' }),
  Object.freeze({ kind: 'package-json', path: 'packages/platform-darwin/package.json' }),
  Object.freeze({ kind: 'package-json', path: 'packages/platform-linux/package.json' }),
  Object.freeze({ kind: 'package-json', path: 'packages/platform-windows/package.json' }),
  Object.freeze({
    kind: 'json-key',
    path: 'packages/contract/schemas/contract.json',
    key: 'versions.product'
  }),
  Object.freeze({
    kind: 'json-key',
    path: 'packages/platform-linux/assets/payload.json',
    key: 'productVersion'
  }),
  Object.freeze({
    kind: 'json-key',
    path: 'packages/platform-windows/assets/payload.json',
    key: 'productVersion'
  }),
  Object.freeze({ kind: 'js-product', path: 'packages/contract/src/versions.ts' }),
  Object.freeze({ kind: 'npm-pin', path: 'integrations/codex/integration.json' }),
  Object.freeze({ kind: 'npm-pin', path: 'integrations/opencode/integration.json' }),
  Object.freeze({ kind: 'npm-pin', path: 'integrations/omp/integration.json' }),
  Object.freeze({ kind: 'npm-pin', path: 'benchmarks/agents/configs/codex-macos.json' }),
  Object.freeze({ kind: 'npm-pin', path: 'benchmarks/agents/configs/opencode-windows.json' }),
  Object.freeze({ kind: 'npm-pin', path: 'benchmarks/agents/configs/omp-ubuntu.json' })
])

export function parseProductVersion(value) {
  if (typeof value !== 'string' || !PRODUCT_VERSION_PATTERN.test(value)) {
    throw new Error(`Invalid product version: ${String(value)}`)
  }
  return value
}

function jsonKeys(site) {
  if (site.kind === 'package-json') return ['version']
  return site.key.split('.')
}

function readCursor(data, keys, path) {
  let cursor = data
  for (const key of keys.slice(0, -1)) {
    cursor = cursor?.[key]
    if (cursor === null || typeof cursor !== 'object') {
      throw new Error(`${path} is missing ${keys.join('.')}`)
    }
  }
  const last = keys.at(-1)
  if (last === undefined || !Object.hasOwn(cursor, last)) {
    throw new Error(`${path} is missing ${keys.join('.')}`)
  }
  return { cursor, last }
}

async function applyJsonSite(absolutePath, keys, version) {
  const original = await readFile(absolutePath, 'utf8')
  const data = JSON.parse(original)
  const { cursor, last } = readCursor(data, keys, absolutePath)
  if (cursor[last] === version) return false
  cursor[last] = version
  await writeFile(absolutePath, `${JSON.stringify(data, null, 2)}\n`)
  return true
}

async function applyJsProduct(absolutePath, version) {
  const original = await readFile(absolutePath, 'utf8')
  const match = original.match(JS_PRODUCT)
  if (match === null) {
    throw new Error(`${absolutePath} is missing CONTRACT_VERSIONS.product`)
  }
  if (match[2] === version) return false
  await writeFile(absolutePath, original.replace(JS_PRODUCT, `$1${version}$3`))
  return true
}

async function applyNpmPin(absolutePath, version) {
  const original = await readFile(absolutePath, 'utf8')
  const next = original
    .replace(
      new RegExp(`@crosshands/mcp@${PINNED_VERSION_PATTERN}`, 'g'),
      `@crosshands/mcp@${version}`
    )
    .replace(
      new RegExp(`(?<![@/])crosshands@${PINNED_VERSION_PATTERN}`, 'g'),
      `crosshands@${version}`
    )
  if (!next.includes(`crosshands@${version}`) || !next.includes(`@crosshands/mcp@${version}`)) {
    throw new Error(`${absolutePath} is missing a crosshands or @crosshands/mcp pin`)
  }
  if (next === original) return false
  await writeFile(absolutePath, next)
  return true
}

async function applySite(root, site, version) {
  const absolutePath = join(root, site.path)
  switch (site.kind) {
    case 'package-json':
    case 'json-key':
      return applyJsonSite(absolutePath, jsonKeys(site), version)
    case 'js-product':
      return applyJsProduct(absolutePath, version)
    case 'npm-pin':
      return applyNpmPin(absolutePath, version)
    default:
      throw new Error(`Unknown version site kind: ${site.kind}`)
  }
}

async function updateAgentConfigHashes(root) {
  const catalogPath = join(root, AGENT_CATALOG)
  const original = await readFile(catalogPath, 'utf8')
  const catalog = JSON.parse(original)
  if (!Array.isArray(catalog.agents)) {
    throw new Error(`${AGENT_CATALOG} has no agents array`)
  }
  const digests = await Promise.all(
    catalog.agents.map(async (agent) => {
      if (typeof agent.config !== 'string') {
        throw new Error(`${AGENT_CATALOG} agent ${String(agent.id)} has no config path`)
      }
      return sha256(join(root, 'benchmarks/agents', agent.config))
    })
  )
  let changed = false
  for (const [index, agent] of catalog.agents.entries()) {
    if (agent.configSha256 === digests[index]) continue
    agent.configSha256 = digests[index]
    changed = true
  }
  if (!changed) return false
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
  return true
}

export async function setProductVersion({ root, version }) {
  const productVersion = parseProductVersion(version)
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('root is required')
  }
  const results = await Promise.all(
    VERSION_SITES.map(async (site) => {
      const changed = await applySite(root, site, productVersion)
      return changed ? site.path : undefined
    })
  )
  const changedPaths = results.filter((path) => path !== undefined)
  const pinChanged = VERSION_SITES.some(
    (site) => site.kind === 'npm-pin' && changedPaths.includes(site.path)
  )
  if (pinChanged && (await updateAgentConfigHashes(root))) {
    changedPaths.push(AGENT_CATALOG)
  }
  return { version: productVersion, changedPaths }
}

function parseArgs(argv) {
  let version
  let root = workspaceRoot
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--root requires a directory')
      root = resolve(value)
      index += 1
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`)
    if (version !== undefined) throw new Error(`Unexpected argument: ${arg}`)
    version = arg
  }
  if (version === undefined) {
    throw new Error('Usage: node scripts/package/set-product-version.mjs <version> [--root <dir>]')
  }
  return { root, version: parseProductVersion(version) }
}

async function main() {
  const result = await setProductVersion(parseArgs(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  await main()
}
