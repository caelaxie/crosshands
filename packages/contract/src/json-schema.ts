import { COMPUTER_OPERATIONS, PUBLIC_OPERATIONS } from './operations.js'
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
