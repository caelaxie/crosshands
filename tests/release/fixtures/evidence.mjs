import { REQUIRED_RELEASE_PACKAGES, packageSetSha256 } from '../../../benchmarks/agents/model.mjs'

function packageRecords(version = '0.1.0') {
  return REQUIRED_RELEASE_PACKAGES.map((name, index) => ({
    name,
    version,
    file: `${name.replaceAll('@', '').replaceAll('/', '-')}-${version}.tgz`,
    sha256: `${index + 1}`.repeat(64)
  }))
}

export function validAgentEvidence(definition, candidatePackageSetSha256) {
  const configs = definition.catalog.agents.map(({ id: agentId }) => {
    const config = definition.configs[agentId]
    return {
      agentId,
      agentVersion: config.agentVersion,
      model: config.model,
      approvalMode: config.approvalMode,
      network: config.network,
      runner: config.runner,
      configSha256: definition.configDigests[agentId]
    }
  })
  const runs = definition.catalog.agents.flatMap(({ id: agentId }) =>
    definition.catalog.adapters.flatMap((adapter) =>
      [1, 2, 3, 4, 5].map((runNumber) => ({
        runId: `${agentId}-${adapter}-${runNumber}`,
        runNumber,
        agentId,
        adapter,
        taskId: 'reference-form-workflow',
        status: runNumber <= 4 ? 'passed' : 'failed',
        failureClass: runNumber <= 4 ? null : 'agent-task-failure',
        durationMs: 1000 + runNumber,
        oracleMatched: runNumber <= 4,
        candidateDigest: candidatePackageSetSha256
      }))
    )
  )
  const promptInjectionCharacterization = definition.catalog.agents.flatMap(({ id: agentId }) =>
    definition.catalog.adapters.map((adapter) => ({
      agentId,
      adapter,
      status: 'recorded',
      treatedAsAuthority: false,
      canaryExposed: false,
      recordSha256: 'a'.repeat(64)
    }))
  )
  return {
    schemaVersion: 1,
    freezeId: definition.catalog.freezeId,
    fixtureVersion: definition.catalog.fixtureVersion,
    catalogSha256: definition.catalogSha256,
    candidatePackageSetSha256,
    configs,
    runs,
    invalidatedRuns: [],
    promptInjectionCharacterization,
    rawApplicationContentRetained: false
  }
}

export function validReleaseEvidence(definition, options = {}) {
  const version = options.version ?? '0.1.0'
  const packages = options.packages ?? packageRecords(version)
  const packageSet = packageSetSha256(packages)
  const releaseManifestSha256 = options.releaseManifestSha256 ?? 'f'.repeat(64)
  const legalNotices =
    options.legalNotices ??
    packages.map((item, index) => ({
      package: item.name,
      path: 'LICENSE',
      sha256: `${index}`.repeat(64)
    }))
  return {
    schemaVersion: 1,
    policyId: definition.policy.policyId,
    version,
    candidate: {
      packageSetSha256: packageSet,
      releaseManifestSha256,
      packages
    },
    defaultChannel: {
      packageSetSha256: packageSet,
      releaseManifestSha256,
      packages: structuredClone(packages)
    },
    signatures: {
      releaseManifest: {
        sha256: releaseManifestSha256,
        signature: 'ed25519:candidate-manifest-signature',
        signerFingerprint: options.signerFingerprint ?? `sha256:${'a'.repeat(64)}`
      },
      platforms: {
        darwin: {
          identity: 'Developer ID Application: CrossHands Project (ABCDE12345)',
          fingerprint: 'SHA256:MACOS-SIGNER-FINGERPRINT',
          notarizationTicket: 'notary-ticket-2026-07-10'
        },
        win32: {
          payloadSha256: 'b'.repeat(64),
          unsigned: 'unsigned-payload'
        },
        linux: {
          payloadSha256: 'b'.repeat(64),
          manifestSignature: 'ed25519:linux-payload-signature'
        }
      }
    },
    sbom: { file: 'sbom.spdx.json', sha256: options.sbomSha256 ?? 'c'.repeat(64) },
    legalNotices,
    owners: definition.policy.requiredRoles.map((role, index) => ({
      role,
      person: `owner-${index + 1}`,
      decision: 'go',
      signature: `approval-signature-${index + 1}`,
      signedAt: '2026-07-10T00:00:00Z'
    })),
    conformance: {
      catalogVersion: definition.policy.conformanceCatalogVersion,
      catalogDigest: definition.policy.conformanceCatalogDigest,
      cells: definition.policy.cells.map((cell) => ({
        ...cell,
        osVersion: cell.osVersion ?? cell.allowedVersions[0],
        osBuild:
          cell.platform === 'darwin'
            ? '25F100'
            : cell.platform === 'win32'
              ? '26200.1000'
              : '6.8.0-100-generic',
        matrixAdjudication:
          cell.id === 'windows11-current-x64'
            ? '25H2 selected because the runner is not a 26H1 new-device platform'
            : undefined,
        runnerImageSha256: '5'.repeat(64),
        runnerBaselineSha256: 'd'.repeat(64),
        driverSha256: 'e'.repeat(64),
        candidatePackageSetSha256: packageSet,
        nodeGates: definition.policy.nodeVersions.map((node) => ({
          node,
          package: true,
          cli: true,
          mcp: true
        })),
        tasks: definition.policy.mandatoryTasks.map((taskId) => ({
          taskId,
          denominator: definition.policy.repetitionsPerTask,
          passed: cell.minimumPasses,
          productFailures: definition.policy.repetitionsPerTask - cell.minimumPasses,
          infrastructureFailures: 0,
          automaticRetries: 0,
          recordsSha256: 'e'.repeat(64)
        })),
        invalidatedRuns: [],
        exclusions: []
      }))
    },
    adapterParity: {
      broker: true,
      cli: true,
      mcp: true,
      recordsSha256: '1'.repeat(64)
    },
    zeroTolerance: definition.policy.zeroToleranceCases.map((zeroToleranceCase) => ({
      case: zeroToleranceCase,
      violations: 0,
      passed: true,
      recordsSha256: '2'.repeat(64)
    })),
    agentEvidence: validAgentEvidence(definition, packageSet),
    rollback: {
      completed: true,
      mainPackageMovedFirst: true,
      sameDigestPromotion: true,
      lastKnownGoodVersion: '0.0.9',
      ownerRole: 'rollback-owner',
      decision: 'rollback-ready',
      recordsSha256: '3'.repeat(64)
    },
    canaries: definition.policy.canaryHours.flatMap((hour) =>
      definition.policy.canaryPlatforms.map((platform) => ({
        hour,
        platform,
        packageSetSha256: packageSet,
        signature: true,
        install: true,
        doctor: true,
        handshake: true,
        mcpInitialize: true,
        cliMutation: true,
        mcpMutation: true,
        safety: true,
        decision: 'continue',
        owner: `${platform}-canary-owner`,
        recordsSha256: '4'.repeat(64)
      }))
    ),
    privacy: {
      rawApplicationContentRetained: false,
      retentionDays: definition.policy.evidenceRetentionDays,
      ownerRole: 'release-coordinator'
    }
  }
}
