import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { create as createTar } from 'tar'
import { afterEach, expect, it } from 'vitest'

import { archiveEntries, archiveManifest } from '../../scripts/package/lib.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

it('lists and reads a packed archive from an absolute temp path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'CrossHands tar drive path '))
  temporaryDirectories.push(directory)
  await mkdir(join(directory, 'package'))
  await writeFile(
    join(directory, 'package/package.json'),
    `${JSON.stringify({ name: 'fixture', version: '0.0.0' })}\n`
  )
  const archive = join(directory, 'fixture-0.0.0.tgz')
  await createTar({ cwd: directory, file: archive, gzip: true, portable: true }, ['package'])
  await expect(archiveManifest(archive)).resolves.toEqual({ name: 'fixture', version: '0.0.0' })
  expect((await archiveEntries(archive)).map((entry) => entry.path)).toContain('package.json')
})
