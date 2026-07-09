import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

import {
  COMPUTER_OPERATIONS,
  contractJsonSchemas,
  parseOperationInput,
  type ComputerOperationName
} from '../../packages/contract/src/index.js'

const contextToken = 'ctx_1234567890abcdefghijklmnopqrstuv'
const targetRef = {
  ref: 'element:7',
  kind: 'element',
  contextToken,
  brokerGeneration: 'broker-1',
  providerGeneration: 'provider-1',
  graphicalSessionId: 'session-1',
  process: { pid: 42, startedAt: '2026-07-10T00:00:00.000Z', executableId: 'fixture.app' },
  appId: 'fixture.app',
  window: { id: 'window-1', ownerPid: 42 },
  snapshotId: 'snapshot-1',
  desktopEpoch: 3,
  expiresAt: '2026-07-10T00:02:00.000Z'
} as const

const validInputs: Record<ComputerOperationName, unknown> = {
  capabilities: {},
  permissions: {},
  listApps: {},
  listWindows: { app: 'fixture.app' },
  getAppState: { app: 'fixture.app', window: { id: 'window-1' } },
  click: { contextToken, target: { kind: 'element', ref: targetRef }, clickCount: 1 },
  performSecondaryAction: { contextToken, target: targetRef, action: 'AXPress' },
  scroll: {
    contextToken,
    target: { kind: 'element', ref: targetRef },
    direction: 'down',
    pages: 1
  },
  drag: {
    contextToken,
    from: { kind: 'coordinate', window: targetRef, x: 10, y: 20 },
    to: { kind: 'coordinate', window: targetRef, x: 30, y: 40 }
  },
  typeText: { contextToken, target: targetRef, text: 'hello' },
  pressKey: { contextToken, target: targetRef, key: 'Return' },
  hotkey: { contextToken, target: targetRef, keys: ['CmdOrCtrl', 'A'] },
  pasteText: { contextToken, target: targetRef, text: 'exact text' },
  setValue: { contextToken, target: targetRef, value: '' }
}

describe('computer operation catalog', () => {
  it('preserves all 14 Orca-familiar operations', () => {
    expect(Object.keys(COMPUTER_OPERATIONS)).toEqual(Object.keys(validInputs))
    expect(Object.keys(COMPUTER_OPERATIONS)).toHaveLength(14)
  })

  it.each(Object.entries(validInputs))('accepts valid %s input', (operation, input) => {
    expect(() => parseOperationInput(operation as ComputerOperationName, input)).not.toThrow()
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
        new URL('../../packages/contract/test/fixtures/orca-8adfef4.json', import.meta.url),
        'utf8'
      )
    ) as { crosshandsOperations: string[] }

    expect(schemaArtifact).toEqual(contractJsonSchemas)
    expect(compatibility.crosshandsOperations).toEqual(Object.keys(COMPUTER_OPERATIONS))
  })
})
