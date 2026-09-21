import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parsePublicReadme } from '../src/public-document.mjs'

const websiteRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(websiteRoot, '..')
const html = await readFile(join(websiteRoot, 'dist/index.html'), 'utf8')
const document = parsePublicReadme(await readFile(join(repoRoot, 'README.md'), 'utf8'))
const decoded = html
  .replaceAll('&#39;', "'")
  .replaceAll('&quot;', '"')
  .replaceAll('&amp;', '&')
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')

if (!decoded.includes(document.prompt.body)) {
  throw new Error('built HTML is missing the Prompt fence text')
}
if (/<h2\b[^>]*>\s*license\s*<\/h2>/i.test(html)) {
  throw new Error('built HTML contains a License heading')
}
if (html.includes('THIRD_PARTY_NOTICES.md')) {
  throw new Error('built HTML contains THIRD_PARTY_NOTICES.md')
}
if (html.includes('Lovecast Inc.')) {
  throw new Error('built HTML contains Lovecast Inc.')
}
if (!/<h2\b[^>]*>\s*Prompt\s*<\/h2>/.test(html)) {
  throw new Error('built HTML is missing a Prompt heading')
}
if (!html.includes('crosshands-mcp')) {
  throw new Error('built HTML is missing crosshands-mcp')
}
if (!html.includes('Copy prompt')) {
  throw new Error('built HTML is missing the Copy prompt control')
}
if (!html.includes('crosshands.caelaxie.com')) {
  throw new Error('built HTML is missing the custom domain')
}
