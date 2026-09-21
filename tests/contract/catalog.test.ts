import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

import {
  COMPUTER_OPERATIONS,
  contractJsonSchemas,
  parseOperationInput,
  type ComputerOperationName
} from '../../packages/contract/src/index.js'

const contextToken = 'ctx_1234567890abcdefghijklmnopqrstuv'

const validInputs: Record<ComputerOperationName, unknown> = {
  capabilities: {},
  permissions: {},
  listApps: {},
  listWindows: { app: 'fixture.app' },
  getAppState: { app: 'fixture.app', window: { id: 'window-1' } },
  click: { contextToken, target: { kind: 'element', elementIndex: 7 }, clickCount: 1 },
  performSecondaryAction: {
    contextToken,
    target: { kind: 'element', elementIndex: 7 },
    action: 'AXPress'
  },
  scroll: {
    contextToken,
    target: { kind: 'coordinate', x: 10, y: 20 },
    direction: 'down',
    pages: 1
  },
  drag: {
    contextToken,
    from: { kind: 'coordinate', x: 10, y: 20 },
    to: { kind: 'coordinate', x: 30, y: 40 }
  },
  typeText: { contextToken, target: { kind: 'context-window' }, text: 'hello' },
  pressKey: { contextToken, target: { kind: 'context-window' }, key: 'Return' },
  hotkey: { contextToken, target: { kind: 'context-window' }, keys: ['CmdOrCtrl', 'A'] },
  pasteText: { contextToken, target: { kind: 'context-window' }, text: 'exact text' },
  setValue: { contextToken, target: { kind: 'element', elementIndex: 7 }, value: '' }
}

describe('computer operation catalog', () => {
  it('preserves all 14 Orca-familiar operations', () => {
    expect(Object.keys(COMPUTER_OPERATIONS)).toEqual(Object.keys(validInputs))
    expect(Object.keys(COMPUTER_OPERATIONS)).toHaveLength(14)
  })

  it.each(Object.entries(validInputs))('accepts valid %s input', (operation, input) => {
    expect(() => parseOperationInput(operation as ComputerOperationName, input)).not.toThrow()
  })

  it('accepts getAppState bound to a context token', () => {
    expect(() => parseOperationInput('getAppState', { contextToken })).not.toThrow()
  })

  it('rejects unknown, contradictory, and out-of-range fields', () => {
    expect(() => parseOperationInput('capabilities', { surprise: true })).toThrow()
    expect(() =>
      parseOperationInput('getAppState', {
        app: 'fixture.app',
        window: { id: 'window-1', index: 1 }
      })
    ).toThrow()
    expect(() =>
      parseOperationInput('click', {
        ...validInputs.click,
        clickCount: 0
      })
    ).toThrow()
  })

  it('accepts click modifiers using hotkey tokens', () => {
    expect(() =>
      parseOperationInput('click', {
        ...validInputs.click,
        modifiers: ['Shift', 'CmdOrCtrl']
      })
    ).not.toThrow()
  })

  it('rejects empty or unknown click modifier fields', () => {
    expect(() =>
      parseOperationInput('click', {
        ...validInputs.click,
        modifiers: []
      })
    ).toThrow()
    expect(() =>
      parseOperationInput('click', {
        ...validInputs.click,
        modifiers: ['Hyper']
      })
    ).toThrow()
    expect(() =>
      parseOperationInput('click', {
        ...validInputs.click,
        modifier: 'Shift'
      })
    ).toThrow()
  })

  it('exports JSON Schema from the same runtime definitions', () => {
    for (const [name, operation] of Object.entries(COMPUTER_OPERATIONS)) {
      expect(contractJsonSchemas.operations[name]?.input).toEqual(
        operation.input.toJSONSchema({ target: 'draft-2020-12' })
      )
      expect(contractJsonSchemas.operations[name]?.output).toEqual(
        operation.output.toJSONSchema({ target: 'draft-2020-12' })
      )
    }
  })

  it('keeps the checked-in schema artifact and pinned compatibility vector current', async () => {
    const schemaArtifact = JSON.parse(
      await readFile(
        new URL('../../packages/contract/schemas/contract.json', import.meta.url),
        'utf8'
      )
    ) as unknown
    const compatibility = JSON.parse(
      await readFile(
        new URL('../../packages/contract/test/fixtures/orca-9c8f4c3.json', import.meta.url),
        'utf8'
      )
    ) as { crosshandsOperations: string[] }

    expect(schemaArtifact).toEqual(contractJsonSchemas)
    expect(compatibility.crosshandsOperations).toEqual(Object.keys(COMPUTER_OPERATIONS))
  })
})
