import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { parsePublicReadme, PublicReadmeError } from '../../website/src/public-document.mjs'

const readmeUrl = new URL('../../README.md', import.meta.url)

function thrownCode(raw: string) {
  try {
    parsePublicReadme(raw)
    return undefined
  } catch (error) {
    return error instanceof PublicReadmeError ? error.code : undefined
  }
}

describe('parsePublicReadme', () => {
  it('projects the repo README without License', async () => {
    const document = parsePublicReadme(await readFile(readmeUrl, 'utf8'))

    expect(document.title).toBe('CrossHands')
    expect(document.lead).toContain('local computer-use runtime for coding agents')
    expect(document.lead).not.toContain('THIRD_PARTY_NOTICES.md')
    expect(document.prompt.heading).toBe('Prompt')
    expect(document.prompt.lead).toBe('Paste this into any coding agent:')
    expect(document.prompt.body).toContain('npm install --global @crosshands/cli @crosshands/mcp')
    expect(document.prompt.body).toContain('crosshands-mcp')
    expect('license' in document).toBe(false)
    expect(document.extra.map((section) => section.heading)).not.toContain('License')
  })

  it('throws missing_omitted_heading when License is removed', async () => {
    const readme = await readFile(readmeUrl, 'utf8')
    const withoutLicense = readme.slice(0, readme.indexOf('\n## License\n'))

    expect(thrownCode(withoutLicense)).toBe('missing_omitted_heading')
  })

  it('throws missing_required_heading when Prompt is renamed', async () => {
    const readme = await readFile(readmeUrl, 'utf8')
    const withoutPrompt = readme.replace('\n## Prompt\n', '\n## Install\n')

    expect(thrownCode(withoutPrompt)).toBe('missing_required_heading')
  })
})
