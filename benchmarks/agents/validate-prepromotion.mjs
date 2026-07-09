#!/usr/bin/env node

import { createPublicKey, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadBenchmarkDefinition, packageSetSha256, validateAgentEvidence } from './model.mjs'
import { signerFingerprint, stableJson } from '../../scripts/package/lib.mjs'

export function validatePrepromotionEvidence({
  combined,
  conformanceEnvelope,
  agentEnvelope,
  manifest,
  definition,
  version,
  manifestSha256
}) {
  const conformance = conformanceEnvelope.conformance ?? conformanceEnvelope
  const agentEvidence = agentEnvelope.agentEvidence ?? agentEnvelope
  if (stableJson(combined.conformance) !== stableJson(conformance)) {
    throw new Error('combined release evidence does not bind the downloaded conformance artifact')
  }
  if (stableJson(combined.agentEvidence) !== stableJson(agentEvidence)) {
    throw new Error('combined release evidence does not bind the downloaded agent artifact')
  }
  if (combined.version !== version) throw new Error('release evidence version mismatch')
  if (combined.candidate.releaseManifestSha256 !== manifestSha256) {
    throw new Error('release evidence points to a different candidate manifest')
  }

  const packageSet = packageSetSha256(combined.candidate.packages)
  if (packageSet !== combined.candidate.packageSetSha256) {
    throw new Error('candidate package-set digest mismatch')
  }
  const manifestPackages = new Map(manifest.packages.map((item) => [item.name, item]))
  for (const item of combined.candidate.packages) {
    const packed = manifestPackages.get(item.name)
    if (packed?.version !== item.version || packed?.sha256 !== item.sha256) {
      throw new Error(`candidate artifact identity mismatch: ${item.name}`)
    }
  }
  if (manifestPackages.size !== combined.candidate.packages.length) {
    throw new Error('candidate release manifest package set differs from combined evidence')
  }

  validateAgentEvidence(agentEvidence, definition)
  if (agentEvidence.candidatePackageSetSha256 !== packageSet) {
    throw new Error('agent evidence points to another candidate package set')
  }
  if (
    conformance.catalogVersion !== definition.policy.conformanceCatalogVersion ||
    conformance.catalogDigest !== definition.policy.conformanceCatalogDigest
  ) {
    throw new Error('conformance evidence uses a different frozen task catalog')
  }

  const cells = new Map(conformance.cells.map((cell) => [cell.id, cell]))
  for (const frozen of definition.policy.cells) {
    const cell = cells.get(frozen.id)
    if (cell === undefined) throw new Error(`missing conformance cell: ${frozen.id}`)
    if (cell.candidatePackageSetSha256 !== packageSet) {
      throw new Error(`${frozen.id} tested another candidate`)
    }
    if (!cell.osBuild || !/^[a-f0-9]{64}$/.test(cell.runnerImageSha256 ?? '')) {
      throw new Error(`${frozen.id} did not freeze an exact build and runner image digest`)
    }
    if (cell.exclusions.length !== 0) {
      throw new Error(`${frozen.id} contains an unreviewed exclusion`)
    }
    const results = new Map(cell.tasks.map((task) => [task.taskId, task]))
    for (const taskId of definition.policy.mandatoryTasks) {
      const result = results.get(taskId)
      if (result?.denominator !== 100 || result.passed < frozen.minimumPasses) {
        throw new Error(`${frozen.id}/${taskId} does not meet its blocking threshold`)
      }
      if (result.passed + result.productFailures !== result.denominator) {
        throw new Error(`${frozen.id}/${taskId} dropped scored product failures`)
      }
      if (!/^[a-f0-9]{64}$/.test(result.recordsSha256 ?? '')) {
        throw new Error(`${frozen.id}/${taskId} has no immutable records digest`)
      }
    }
    const nodes = new Set(
      cell.nodeGates.filter((gate) => gate.package && gate.cli && gate.mcp).map((gate) => gate.node)
    )
    if (!definition.policy.nodeVersions.every((node) => nodes.has(node))) {
      throw new Error(`${frozen.id} is missing a blocking Node adapter gate`)
    }
  }
  if (cells.size !== definition.policy.cells.length) {
    throw new Error('unfrozen conformance cell present')
  }

  const zeroToleranceCases = new Set(combined.zeroTolerance.map((record) => record.case))
  if (
    !definition.policy.zeroToleranceCases.every((name) => zeroToleranceCases.has(name)) ||
    zeroToleranceCases.size !== definition.policy.zeroToleranceCases.length
  ) {
    throw new Error('zero-tolerance case set differs from the frozen release policy')
  }
  for (const record of combined.zeroTolerance) {
    if (!record.passed || record.violations !== 0) {
      throw new Error(`zero-tolerance failure: ${record.case}`)
    }
  }
  if (
    !combined.adapterParity.broker ||
    !combined.adapterParity.cli ||
    !combined.adapterParity.mcp
  ) {
    throw new Error('broker/CLI/MCP parity evidence is incomplete')
  }

  const roles = new Map(combined.owners.map((owner) => [owner.role, owner]))
  for (const role of definition.policy.requiredRoles) {
    const owner = roles.get(role)
    if (owner?.decision !== 'go' || !owner.signature) {
      throw new Error(`missing signed go decision: ${role}`)
    }
  }
  if (roles.size !== definition.policy.requiredRoles.length) {
    throw new Error('release approval role set differs from policy')
  }
  if (
    roles.get('signing-provenance-owner').person === roles.get('signing-provenance-backup').person
  ) {
    throw new Error('signing owner and backup are not independent')
  }
  if (
    !combined.rollback.completed ||
    !combined.rollback.mainPackageMovedFirst ||
    !combined.rollback.sameDigestPromotion
  ) {
    throw new Error('rollback readiness evidence is incomplete')
  }
}

async function main() {
  const definition = await loadBenchmarkDefinition()
  const [combined, conformanceEnvelope, agentEnvelope, manifest, signature, publicKeyText] =
    await Promise.all([
      readFile('external-evidence/combined/release-evidence.json', 'utf8').then(JSON.parse),
      readFile('external-evidence/conformance/conformance-evidence.json', 'utf8').then(JSON.parse),
      readFile('external-evidence/agents/agent-evidence.json', 'utf8').then(JSON.parse),
      readFile('artifacts/release/release-manifest.json', 'utf8').then(JSON.parse),
      readFile('external-evidence/combined/release-evidence.sig', 'utf8'),
      readFile('release-evidence.pub', 'utf8')
    ])
  const publicKey = createPublicKey(publicKeyText)
  if (signerFingerprint(publicKey) !== process.env.RELEASE_EVIDENCE_SIGNER_FINGERPRINT) {
    throw new Error('combined release-evidence signer fingerprint changed')
  }
  if (
    !verify(
      null,
      Buffer.from(stableJson(combined)),
      publicKey,
      Buffer.from(signature.trim(), 'base64')
    )
  ) {
    throw new Error('combined release-evidence signature is invalid')
  }
  validatePrepromotionEvidence({
    combined,
    conformanceEnvelope,
    agentEnvelope,
    manifest,
    definition,
    version: process.env.RELEASE_VERSION,
    manifestSha256: process.env.EXPECTED_MANIFEST_SHA256
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main()
}
