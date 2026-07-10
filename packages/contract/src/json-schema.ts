import { COMPUTER_OPERATIONS } from './operations.js'
import { CONTRACT_VERSIONS } from './versions.js'

export const contractJsonSchemas = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  versions: CONTRACT_VERSIONS,
  operations: Object.fromEntries(
    Object.entries(COMPUTER_OPERATIONS).map(([name, operation]) => [
      name,
      {
        mutation: operation.mutation,
        input: operation.input.toJSONSchema({ target: 'draft-2020-12' }),
        output: operation.output.toJSONSchema({ target: 'draft-2020-12' })
      }
    ])
  )
} as const
