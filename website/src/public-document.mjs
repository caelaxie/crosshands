import { readFile } from 'node:fs/promises'

export const OMITTED_HEADINGS = Object.freeze(['License'])
export const REQUIRED_HEADINGS = Object.freeze(['Prompt'])

export class PublicReadmeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PublicReadmeError'
    this.code = code
  }
}

function headingLine(line) {
  const match = /^(#{1,6})[ \t]+(.*)$/.exec(line)
  if (match === null) return undefined
  const text = match[2].replace(/[ \t]+#+\s*$/, '').trim()
  if (text === '') return undefined
  return { level: match[1].length, text }
}

function sectionText(lines, start, end) {
  return lines.slice(start, end).join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
}

function promptFromSection(heading, body) {
  const lines = body.split('\n')
  let fenceStart = -1
  let fenceEnd = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('```')) continue
    if (fenceStart === -1) {
      fenceStart = index
      continue
    }
    fenceEnd = index
    break
  }
  if (fenceStart === -1 || fenceEnd === -1) {
    return { heading, body }
  }
  const lead = lines.slice(0, fenceStart).join('\n').trim()
  const prompt = {
    heading,
    body: lines.slice(fenceStart + 1, fenceEnd).join('\n')
  }
  if (lead !== '') prompt.lead = lead
  return prompt
}

export function parsePublicReadme(raw) {
  const lines = raw.split('\n')
  const headings = []
  let inFence = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const heading = headingLine(line)
    if (heading === undefined) continue
    headings.push({ ...heading, index })
  }

  const titles = headings.filter((heading) => heading.level === 1)
  if (titles.length === 0) {
    throw new PublicReadmeError('missing_h1', 'README is missing an H1')
  }
  if (titles.length > 1) {
    throw new PublicReadmeError('duplicate_heading', `duplicate heading "${titles[1].text}"`)
  }

  const sections = headings.filter((heading) => heading.level === 2)
  const byName = new Map()
  for (const section of sections) {
    if (byName.has(section.text)) {
      throw new PublicReadmeError('duplicate_heading', `duplicate heading "${section.text}"`)
    }
    byName.set(section.text, section)
  }

  for (const heading of REQUIRED_HEADINGS) {
    if (!byName.has(heading)) {
      throw new PublicReadmeError('missing_required_heading', `README is missing ## ${heading}`)
    }
  }
  for (const heading of OMITTED_HEADINGS) {
    if (!byName.has(heading)) {
      throw new PublicReadmeError('missing_omitted_heading', `README is missing ## ${heading}`)
    }
  }

  const title = titles[0]
  const nextAfterTitle = headings.find((heading) => heading.index > title.index)
  const lead = nextAfterTitle
    ? sectionText(lines, title.index + 1, nextAfterTitle.index)
    : sectionText(lines, title.index + 1, lines.length)

  const promptHeading = byName.get('Prompt')
  const promptEnd =
    headings.find((heading) => heading.index > promptHeading.index)?.index ?? lines.length
  const prompt = promptFromSection(
    promptHeading.text,
    sectionText(lines, promptHeading.index + 1, promptEnd)
  )

  const extra = []
  for (const section of sections) {
    if (section.text === 'Prompt' || OMITTED_HEADINGS.includes(section.text)) continue
    const end = headings.find((heading) => heading.index > section.index)?.index ?? lines.length
    extra.push({
      heading: section.text,
      body: sectionText(lines, section.index + 1, end)
    })
  }

  return { title: title.text, lead, prompt, extra }
}

export async function loadPublicDocument(readmeUrl) {
  return parsePublicReadme(await readFile(readmeUrl, 'utf8'))
}

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function paragraphs(markdown) {
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => `<p>${escapeHtml(block)}</p>`)
    .join('\n')
}

export function renderPublicDocument(document) {
  const parts = [`<h1>${escapeHtml(document.title)}</h1>`]
  const leadHtml = paragraphs(document.lead)
  if (leadHtml !== '') parts.push(leadHtml)
  parts.push(`<h2>${escapeHtml(document.prompt.heading)}</h2>`)
  if (document.prompt.lead) parts.push(`<p>${escapeHtml(document.prompt.lead)}</p>`)
  parts.push(`<pre><code>${escapeHtml(document.prompt.body)}</code></pre>`)
  for (const section of document.extra) {
    parts.push(`<h2>${escapeHtml(section.heading)}</h2>`)
    const bodyHtml = paragraphs(section.body)
    if (bodyHtml !== '') parts.push(bodyHtml)
  }
  return parts.join('\n')
}
