import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { workspaceRoot } from '../../scripts/package/lib.mjs'

it('fetches the Apple notary log when a release build is not Accepted', async () => {
  const source = await readFile(join(workspaceRoot, 'scripts/build-native/current.mjs'), 'utf8')
  expect(source).toContain('notarytool')
  expect(source).toContain("'log'")
  expect(source).toContain("status === 'Accepted'")
  expect(source).toContain('--output-format')
})
