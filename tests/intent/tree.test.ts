import { describe, expect, it } from 'vitest'

import { clickableMoves, parseTreeMoves } from '../../packages/cli/src/intent/tree.js'

const NOTES_FRAGMENT = `App=com.apple.Notes (pid 36048)
Window: "Search - Found 1 notes", App: Notes.

0 standard window Search - Found 1 notes
	46 table row standalone computer-use, Secondary Actions: name:trash
 target:0x0
 selector:(null)
	47 cell standalone computer-use
	64 toolbar
		65 button Add Folder
		66 button Folders
		67 menu button View Options
		68 button New Note
		69 button (disabled) Format
		70 button (disabled) Checklist
		77 search text field (disabled), Value: crosshands

The focused UI element is 0 standard window Search - Found 1 notes.
`

describe('parseTreeMoves', () => {
  it('keeps New Note at 68 when a prior row embeds newlines', () => {
    const moves = parseTreeMoves(NOTES_FRAGMENT)
    const byIndex = new Map(moves.map((move) => [move.elementIndex, move]))
    expect(byIndex.get(46)?.line).toContain('Secondary Actions: name:trash')
    expect(byIndex.get(46)?.line).toContain('selector:(null)')
    expect(byIndex.get(46)).toMatchObject({
      role: 'table row',
      label: 'standalone computer-use'
    })
    expect(byIndex.get(46)?.label).not.toContain('selector')
    expect(byIndex.get(68)).toMatchObject({
      elementIndex: 68,
      role: 'button',
      label: 'New Note',
      clickable: true,
      disabled: false
    })
    expect(byIndex.get(69)).toMatchObject({ clickable: false, disabled: true })
    expect(byIndex.get(77)).toMatchObject({
      role: 'search text field',
      label: '(disabled)',
      disabled: true,
      clickable: false,
      settable: true
    })
    expect(byIndex.get(77)?.line).toContain('Value: crosshands')
    expect(clickableMoves(moves).map((move) => move.elementIndex)).toEqual([65, 66, 67, 68])
  })

  it('does not treat header lines as rows', () => {
    const moves = parseTreeMoves(NOTES_FRAGMENT)
    expect(moves.some((move) => move.role.startsWith('App='))).toBe(false)
    expect(moves[0]?.elementIndex).toBe(0)
    expect(moves[0]).toMatchObject({
      role: 'standard window',
      label: 'Search - Found 1 notes'
    })
  })
})

function at(tree: string, index: number) {
  const move = parseTreeMoves(tree).find((item) => item.elementIndex === index)
  if (move === undefined) throw new Error(`missing row ${index}`)
  return move
}

const visibleNames = [
  {
    name: 'keeps the name after a trait list on a button',
    tree: '68 button (selected, expanded) New Note',
    index: 68,
    role: 'button',
    label: '(selected, expanded) New Note',
    line: '68 button (selected, expanded) New Note',
    clickable: true
  },
  {
    name: 'keeps trait commas when a value and secondary actions follow',
    tree: '68 button (selected, settable) New Note, Value: CANARY, Secondary Actions: press',
    index: 68,
    role: 'button',
    label: '(selected, settable) New Note',
    lineHas: 'CANARY',
    labelLacks: 'CANARY',
    clickable: true,
    settable: true
  },
  {
    name: 'keeps the name of a selected disabled button',
    tree: '69 button (selected, disabled) Format',
    index: 69,
    role: 'button',
    label: '(selected, disabled) Format',
    clickable: false,
    disabled: true
  },
  {
    name: 'drops a text field value and keeps trait commas',
    tree: '40 text field (selected, settable) Compose, Value: CANARY-ESSAY',
    index: 40,
    role: 'text field',
    label: '(selected, settable) Compose',
    lineHas: 'CANARY-ESSAY',
    labelLacks: 'CANARY',
    clickable: true,
    settable: true
  },
  {
    name: 'drops a value when the field has no name',
    tree: '3 text field, Value: CANARY-ONLY',
    index: 3,
    role: 'text field',
    label: '',
    lineHas: 'CANARY-ONLY',
    labelLacks: 'CANARY',
    settable: true
  },
  {
    name: 'drops a bare placeholder that has no comma',
    tree: '3 text field Placeholder: CANARY-HINT',
    index: 3,
    role: 'text field',
    label: '',
    lineHas: 'CANARY-HINT',
    labelLacks: 'CANARY'
  },
  {
    name: 'drops a bare placeholder after a trait list',
    tree: '3 text field (selected, settable) Placeholder: CANARY-HINT',
    index: 3,
    role: 'text field',
    label: '(selected, settable)',
    lineHas: 'CANARY-HINT',
    labelLacks: 'CANARY',
    settable: true
  },
  {
    name: 'keeps the name before a comma placeholder',
    tree: '43 text field Address, Placeholder: CANARY-HINT',
    index: 43,
    role: 'text field',
    label: 'Address',
    lineHas: 'CANARY-HINT',
    labelLacks: 'CANARY'
  },
  {
    name: 'drops a description',
    tree: '44 button Save, Description: CANARY-SUBTITLE',
    index: 44,
    role: 'button',
    label: 'Save',
    lineHas: 'CANARY-SUBTITLE',
    labelLacks: 'CANARY'
  },
  {
    name: 'drops a text summary',
    tree: '44 button Save, Text: CANARY-BODY',
    index: 44,
    role: 'button',
    label: 'Save',
    lineHas: 'CANARY-BODY',
    labelLacks: 'CANARY'
  },
  {
    name: 'drops secondary actions',
    tree: '44 button Save, Secondary Actions: press, show menu',
    index: 44,
    role: 'button',
    label: 'Save',
    lineHas: 'show menu',
    labelLacks: 'show menu'
  },
  {
    name: 'cuts at the earliest renderer mark',
    tree: '40 text field Name, Text: short, Value: CANARY-LONG, Placeholder: later',
    index: 40,
    role: 'text field',
    label: 'Name',
    lineHas: 'CANARY-LONG',
    labelLacks: 'CANARY'
  },
  {
    name: 'keeps a comma that is part of the name',
    tree: '44 button Save, as draft, Secondary Actions: press',
    index: 44,
    role: 'button',
    label: 'Save, as draft',
    lineHas: 'press',
    labelLacks: 'press'
  },
  {
    name: 'keeps a name that merely contains the word Value',
    tree: '44 button Value: something',
    index: 44,
    role: 'button',
    label: 'Value: something'
  },
  {
    name: 'cuts a name at an embedded placeholder mark',
    tree: '44 button See Placeholder: CANARY-DOCS',
    index: 44,
    role: 'button',
    label: 'See',
    lineHas: 'CANARY-DOCS',
    labelLacks: 'CANARY'
  },
  {
    name: 'keeps a comma inside a link name and drops the description',
    tree: '8 link [Save, as draft](https://example.com), Description: CANARY-OPEN',
    index: 8,
    role: 'link',
    label: '[Save, as draft](https://example.com)',
    lineHas: 'CANARY-OPEN',
    labelLacks: 'CANARY',
    clickable: true
  },
  {
    name: 'keeps a check box name after settable and selected traits',
    tree: '15 check box (selected, settable) Include, Description: CANARY-MAIL',
    index: 15,
    role: 'check box',
    label: '(selected, settable) Include',
    lineHas: 'CANARY-MAIL',
    labelLacks: 'CANARY',
    clickable: true,
    settable: true
  },
  {
    name: 'keeps a radio button name',
    tree: '16 radio button (selected) AM, Value: 1',
    index: 16,
    role: 'radio button',
    label: '(selected) AM',
    lineHas: 'Value: 1',
    labelLacks: 'Value',
    clickable: true
  },
  {
    name: 'keeps a menu button name',
    tree: '17 menu button View Options, Secondary Actions: show menu',
    index: 17,
    role: 'menu button',
    label: 'View Options',
    clickable: true
  },
  {
    name: 'keeps a combo box name and drops its value',
    tree: '18 combo box (expanded, settable) Font, Value: CANARY-MENLO',
    index: 18,
    role: 'combo box',
    label: '(expanded, settable) Font',
    lineHas: 'CANARY-MENLO',
    labelLacks: 'CANARY',
    clickable: true,
    settable: true
  },
  {
    name: 'keeps a pop up button name',
    tree: '19 pop up button (expanded) Zoom, Secondary Actions: show menu',
    index: 19,
    role: 'pop up button',
    label: '(expanded) Zoom',
    clickable: true
  },
  {
    name: 'keeps a disclosure triangle name',
    tree: '20 disclosure triangle (expanded) Sidebar',
    index: 20,
    role: 'disclosure triangle',
    label: '(expanded) Sidebar',
    clickable: true
  },
  {
    name: 'reads a role with no name',
    tree: '5 button',
    index: 5,
    role: 'button',
    label: '',
    clickable: true
  },
  {
    name: 'reads traits when the control has no name',
    tree: '5 button (selected, settable)',
    index: 5,
    role: 'button',
    label: '(selected, settable)',
    settable: true
  },
  {
    name: 'does not treat a longer word as a multi-word role',
    tree: '21 text fielded Name, Value: CANARY',
    index: 21,
    role: 'text',
    label: 'fielded Name',
    lineHas: 'CANARY',
    labelLacks: 'CANARY'
  },
  {
    name: 'preserves the role casing from the row',
    tree: '22 Menu Button File, Value: CANARY',
    index: 22,
    role: 'Menu Button',
    label: 'File',
    lineHas: 'CANARY',
    labelLacks: 'CANARY'
  },
  {
    name: 'keeps a comma in a window title',
    tree: '0 standard window Notes, Today',
    index: 0,
    role: 'standard window',
    label: 'Notes, Today',
    clickable: false
  },
  {
    name: 'trims space around the name',
    tree: '8 button    New Note',
    index: 8,
    role: 'button',
    label: 'New Note'
  },
  {
    name: 'drops a value that follows traits and no name',
    tree: '5 button (selected, settable), Value: CANARY-IGNORED',
    index: 5,
    role: 'button',
    label: '(selected, settable)',
    lineHas: 'CANARY-IGNORED',
    labelLacks: 'CANARY',
    settable: true
  },
  {
    name: 'prefers search text field over text field',
    tree: '77 search text field Query, Value: CANARY',
    index: 77,
    role: 'search text field',
    label: 'Query',
    lineHas: 'CANARY',
    labelLacks: 'CANARY',
    settable: true,
    clickable: true
  }
] as const

describe('visible control names', () => {
  it.each(visibleNames)('$name', (spec) => {
    const move = at(spec.tree, spec.index)
    expect(move).toMatchObject({
      role: spec.role,
      label: spec.label,
      ...('clickable' in spec ? { clickable: spec.clickable } : {}),
      ...('disabled' in spec ? { disabled: spec.disabled } : {}),
      ...('settable' in spec ? { settable: spec.settable } : {})
    })
    if ('line' in spec) expect(move.line).toBe(spec.line)
    if ('lineHas' in spec) expect(move.line).toContain(spec.lineHas)
    if ('labelLacks' in spec) expect(move.label).not.toContain(spec.labelLacks)
  })

  it('drops wrapped lines from the name and keeps them on the raw row', () => {
    const tree = [
      '41 text area Body',
      'CANARY-AREA keeps going, Value: still here',
      '46 table row standalone computer-use, Secondary Actions: name:trash',
      ' target:0x0',
      ' selector:(null)'
    ].join('\n')
    const area = at(tree, 41)
    const row = at(tree, 46)
    expect(area).toMatchObject({ role: 'text area', label: 'Body', settable: true })
    expect(area.line).toContain('CANARY-AREA')
    expect(area.label).not.toContain('CANARY-AREA')
    expect(row).toMatchObject({ role: 'table row', label: 'standalone computer-use' })
    expect(row.line).toContain('selector:(null)')
    expect(row.label).not.toContain('selector')
  })

  it('keeps an unmarked text-role value because that renderer gives it no boundary', () => {
    const body = 'm'.repeat(300)
    const move = at(`12 text ${body}`, 12)
    expect(move).toMatchObject({ role: 'text', label: body, clickable: false })
  })

  it('keeps a multi-thousand-character visible name and still drops the value', () => {
    const name = 'N'.repeat(5000)
    const move = at(`12 button ${name}, Value: CANARY-ESSAY`, 12)
    expect(move.label).toBe(name)
    expect(move.line).toContain('CANARY-ESSAY')
    expect(move.label).not.toContain('CANARY')
  })

  it('drops a long bare placeholder', () => {
    const hint = `CANARY-HINT ${'h'.repeat(400)}`
    const move = at(`3 text field Placeholder: ${hint}`, 3)
    expect(move).toMatchObject({ role: 'text field', label: '' })
    expect(move.line).toContain('CANARY-HINT')
    expect(move.label).not.toContain('CANARY')
  })

  it('does not read disabled or settable out of a field value', () => {
    const disabled = at('44 button Save, Value: (selected, disabled)', 44)
    const settable = at('45 button Save, Value: (settable)', 45)
    expect(disabled).toMatchObject({
      label: 'Save',
      disabled: false,
      clickable: true,
      settable: false
    })
    expect(disabled.line).toContain('(selected, disabled)')
    expect(settable).toMatchObject({ label: 'Save', settable: false, clickable: true })
  })

  it('reads an indented button trait list', () => {
    const move = at('\t\t68 button (selected, expanded) New Note', 68)
    expect(move).toMatchObject({
      role: 'button',
      label: '(selected, expanded) New Note',
      clickable: true,
      disabled: false
    })
  })
})
