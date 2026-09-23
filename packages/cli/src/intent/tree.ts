export type TreeMove = {
  elementIndex: number
  role: string
  label: string
  line: string
  disabled: boolean
  clickable: boolean
  settable: boolean
}

const ROW_START = /^(\t*)(\d+) (.+)$/
const MULTI_WORD_ROLES = [
  'search text field',
  'text field',
  'text area',
  'menu button',
  'pop up button',
  'popup button',
  'radio button',
  'check box',
  'combo box',
  'disclosure triangle',
  'standard window',
  'scroll area',
  'split group',
  'outline row',
  'table row'
] as const
const CLICKABLE_ROLE = new Set([
  'button',
  'link',
  'checkbox',
  'check box',
  'radio button',
  'radio',
  'tab',
  'menu button',
  'pop up button',
  'popup button',
  'combo box',
  'disclosure triangle'
])
const SETTABLE_ROLE = new Set(['text field', 'search text field', 'text area', 'combo box'])

function isHeaderOrFooter(line: string): boolean {
  if (line.length === 0) return true
  if (line.startsWith('App=')) return true
  if (line.startsWith('Window:')) return true
  if (line.startsWith('The focused UI element')) return true
  if (line.startsWith('No UI element')) return true
  return false
}

// Darwin, Linux, and Windows append these after the visible name.
// Darwin writes a leading space and no comma on Placeholder when name and value are absent.
const METADATA_MARK = /, (?:Value|Placeholder|Description|Text|Secondary Actions):| Placeholder:/

function visibleControlText(body: string): string {
  const newline = body.indexOf('\n')
  const firstLine = newline === -1 ? body : body.slice(0, newline)
  const mark = firstLine.search(METADATA_MARK)
  const visible = mark === -1 ? firstLine : firstLine.slice(0, mark)
  return visible.trim()
}

const DISABLED_TRAIT = /\((?:[^)]*,\s*)?disabled(?:\s*,[^)]*)?\)/
const SETTABLE_TRAIT = /\((?:[^)]*,\s*)?settable(?:\s*,[^)]*)?\)/

function splitRole(visible: string): { role: string; label: string } {
  const lower = visible.toLowerCase()
  const multi = MULTI_WORD_ROLES.find(
    (role) =>
      lower.startsWith(role) &&
      (visible.length === role.length || /[\s,(]/.test(visible[role.length]!))
  )
  if (multi !== undefined) {
    return {
      role: visible.slice(0, multi.length),
      label: visible
        .slice(multi.length)
        .replace(/^[\s,]+/, '')
        .trim()
    }
  }
  const space = visible.indexOf(' ')
  if (space === -1) return { role: visible, label: '' }
  return { role: visible.slice(0, space), label: visible.slice(space + 1).trim() }
}

export function parseTreeMoves(treeText: string): TreeMove[] {
  const rows: { elementIndex: number; body: string }[] = []
  for (const line of treeText.split('\n')) {
    const match = ROW_START.exec(line)
    if (match !== null && match[2] !== undefined && match[3] !== undefined) {
      rows.push({ elementIndex: Number(match[2]), body: match[3] })
      continue
    }
    const previous = rows[rows.length - 1]
    if (previous !== undefined && !isHeaderOrFooter(line)) previous.body += `\n${line}`
  }
  return rows.map((row) => {
    const visible = visibleControlText(row.body)
    const { role, label } = splitRole(visible)
    const disabled = DISABLED_TRAIT.test(visible)
    const roleKey = role.toLowerCase()
    const settable = SETTABLE_TRAIT.test(visible) || SETTABLE_ROLE.has(roleKey)
    const clickable = !disabled && (CLICKABLE_ROLE.has(roleKey) || settable)
    return {
      elementIndex: row.elementIndex,
      role,
      label,
      line: `${row.elementIndex} ${row.body}`,
      disabled,
      clickable,
      settable
    }
  })
}

export const JEV_CHOICE_CAP = 255

export function clickableMoves(moves: readonly TreeMove[]): TreeMove[] {
  const selected = moves.filter((move) => move.clickable)
  if (selected.length <= JEV_CHOICE_CAP) return selected
  return selected.slice(0, JEV_CHOICE_CAP)
}
