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
    expect(byIndex.get(68)).toMatchObject({
      elementIndex: 68,
      role: 'button',
      label: 'New Note',
      clickable: true,
      disabled: false
    })
    expect(byIndex.get(69)).toMatchObject({ clickable: false, disabled: true })
    expect(clickableMoves(moves).map((move) => move.elementIndex)).toEqual([65, 66, 67, 68])
  })

  it('does not treat header lines as rows', () => {
    const moves = parseTreeMoves(NOTES_FRAGMENT)
    expect(moves.some((move) => move.role.startsWith('App='))).toBe(false)
    expect(moves[0]?.elementIndex).toBe(0)
  })
})
