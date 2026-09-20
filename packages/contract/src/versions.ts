import { createComputerError } from './errors.js'

export const CONTRACT_VERSIONS = {
  product: '0.1.6',
  publicContract: '1.1.0',
  brokerControl: 1,
  providerProtocol: 1,
  mcpProtocol: '2025-11-25'
} as const

export type ContractVersions = {
  product: string
  publicContract: string
  brokerControl: number
  providerProtocol: number
  mcpProtocol: string
}

export const COMPATIBLE_VERSIONS = {
  product: [CONTRACT_VERSIONS.product],
  publicContract: [CONTRACT_VERSIONS.publicContract],
  brokerControl: [CONTRACT_VERSIONS.brokerControl],
  providerProtocol: [CONTRACT_VERSIONS.providerProtocol],
  mcpProtocol: [CONTRACT_VERSIONS.mcpProtocol]
} as const

export type VersionNegotiationResult =
  | { ok: true; versions: typeof CONTRACT_VERSIONS }
  | { ok: false; error: ReturnType<typeof createComputerError> }

export function negotiateVersionHandshake(remote: ContractVersions): VersionNegotiationResult {
  for (const domain of Object.keys(CONTRACT_VERSIONS) as (keyof ContractVersions)[]) {
    const accepted = COMPATIBLE_VERSIONS[domain] as readonly (string | number)[]
    if (!accepted.includes(remote[domain])) {
      return {
        ok: false,
        error: createComputerError(
          'version_incompatible',
          `Incompatible ${domain} version ${String(remote[domain])}; expected ${accepted.join(' or ')}`,
          { domain, received: remote[domain], accepted }
        )
      }
    }
  }
  return { ok: true, versions: CONTRACT_VERSIONS }
}
