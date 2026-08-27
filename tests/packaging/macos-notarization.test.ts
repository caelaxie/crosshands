import { expect, it } from 'vitest'

import { assertNotaryAccepted } from '../../scripts/build-native/current.mjs'

it('accepts an Accepted notary report', () => {
  expect(assertNotaryAccepted({ status: 'Accepted', id: 'ok' })).toEqual({
    status: 'Accepted',
    id: 'ok'
  })
})

it('includes the Apple log when notarization is not Accepted', () => {
  expect(() =>
    assertNotaryAccepted({ status: 'Invalid', id: '42dc6bf1' }, 'The.HardenedRuntime')
  ).toThrow(/Invalid \(42dc6bf1\):\nThe\.HardenedRuntime/)
})
