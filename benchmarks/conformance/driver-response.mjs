const CLASSIFICATIONS = new Set(['pass', 'product-failure', 'infrastructure-invalidated'])
const VERIFICATION_STATES = new Set([
  'verified',
  'indeterminate',
  'failed',
  'not-attempted',
  'observation'
])
const FAILURE_CLASSES = new Set([
  'assertion',
  'capability',
  'timeout',
  'provider-crash',
  'adapter-divergence',
  'identity-boundary',
  'peer-boundary',
  'secret-leak',
  'payload-integrity',
  'silent-success',
  'sensitive-target',
  'unsigned-artifact',
  'mcp-stdout-corruption',
  'human-boundary-bypass',
  'rollback-failure'
])
const REQUIRED = [
  'schemaVersion',
  'classification',
  'automaticRetryCount',
  'oracleMatched',
  'normalizedResultDigest',
  'normalizedErrorCode',
  'verificationState',
  'privacy'
]
const OPTIONAL = ['failureClass', 'infrastructureCode', 'runnerEvidence']
const SHA256 = /^sha256:[a-f0-9]{64}$/

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validateDriverResponse(value, catalog) {
  if (!plainObject(value)) throw new Error('driver response must be a JSON object')
  const keys = Object.keys(value)
  for (const key of REQUIRED) {
    if (!keys.includes(key)) throw new Error(`driver response is missing ${key}`)
  }
  for (const key of keys) {
    if (![...REQUIRED, ...OPTIONAL].includes(key)) {
      throw new Error(`driver response contains forbidden field: ${key}`)
    }
  }
  if (value.schemaVersion !== 'crosshands.conformance-driver-response/v1') {
    throw new Error('driver returned an unsupported response schema')
  }
  if (!CLASSIFICATIONS.has(value.classification)) throw new Error('invalid classification')
  if (value.automaticRetryCount !== 0) throw new Error('automatic driver retries are forbidden')
  if (typeof value.oracleMatched !== 'boolean') throw new Error('oracleMatched must be boolean')
  if (!SHA256.test(value.normalizedResultDigest ?? '')) {
    throw new Error('normalized result digest is invalid')
  }
  if (value.normalizedErrorCode !== null && typeof value.normalizedErrorCode !== 'string') {
    throw new Error('normalized error code is invalid')
  }
  if (!VERIFICATION_STATES.has(value.verificationState)) {
    throw new Error('verification state is invalid')
  }
  if (!plainObject(value.privacy) || Object.keys(value.privacy).length !== 4) {
    throw new Error('privacy attestation is incomplete')
  }
  for (const key of [
    'rawAccessibilityRetained',
    'screenshotRetained',
    'clipboardRetained',
    'literalInputRetained'
  ]) {
    if (value.privacy[key] !== false) throw new Error(`privacy attestation failed: ${key}`)
  }

  if (value.classification === 'pass') {
    if (!value.oracleMatched) throw new Error('pass requires an independent oracle match')
    if (OPTIONAL.some((key) => value[key] !== undefined)) {
      throw new Error('pass response contains failure-only evidence')
    }
  } else if (value.classification === 'product-failure') {
    if (!FAILURE_CLASSES.has(value.failureClass))
      throw new Error('product failure class is invalid')
    if (value.infrastructureCode !== undefined || value.runnerEvidence !== undefined) {
      throw new Error('product failure contains infrastructure-only evidence')
    }
  } else {
    if (!catalog.infrastructureInvalidations.includes(value.infrastructureCode)) {
      throw new Error('infrastructure invalidation code is not frozen')
    }
    if (!SHA256.test(value.runnerEvidence ?? '')) {
      throw new Error('infrastructure invalidation lacks an independent evidence digest')
    }
    if (value.failureClass !== undefined) {
      throw new Error('infrastructure invalidation contains a product failure class')
    }
  }
  return value
}
