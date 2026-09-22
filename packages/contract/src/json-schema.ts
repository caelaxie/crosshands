import { COMPUTER_OPERATIONS, PUBLIC_OPERATIONS, type ComputerOperationName } from './operations.js'
import { CONTRACT_VERSIONS } from './versions.js'

function schemaCatalog(operations: typeof COMPUTER_OPERATIONS | typeof PUBLIC_OPERATIONS) {
  return Object.fromEntries(
    Object.entries(operations).map(([name, operation]) => [
      name,
      {
        mutation: operation.mutation,
        input: operation.input.toJSONSchema({ target: 'draft-2020-12' }),
        output: operation.output.toJSONSchema({ target: 'draft-2020-12' })
      }
    ])
  )
}

export const contractJsonSchemas = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  versions: CONTRACT_VERSIONS,
  operations: schemaCatalog(COMPUTER_OPERATIONS),
  publicOperations: schemaCatalog(PUBLIC_OPERATIONS)
} as const

function schemaRequiresGoal(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false
  const record = schema as Record<string, unknown>
  if (Array.isArray(record.required) && record.required.includes('goal')) return true
  for (const key of ['anyOf', 'oneOf']) {
    const branches = record[key]
    if (Array.isArray(branches) && branches.length > 0) return branches.every(schemaRequiresGoal)
  }
  return false
}

export function operationRequiresGoal(operation: ComputerOperationName): boolean {
  return schemaRequiresGoal(contractJsonSchemas.publicOperations[operation]?.input)
}
