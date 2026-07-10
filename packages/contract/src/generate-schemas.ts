import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { contractJsonSchemas } from './json-schema.js'

const here = dirname(fileURLToPath(import.meta.url))
const output = resolve(here, '../schemas/contract.json')
await writeFile(output, `${JSON.stringify(contractJsonSchemas, null, 2)}\n`, 'utf8')
