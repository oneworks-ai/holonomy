import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

describe('Console', () => {
  it('installs the standard logging methods', () => {
    for (const name of ['debug', 'error', 'info', 'log', 'warn']) {
      assert.equal(typeof console[name], 'function')
    }
  })

  it('writes diagnostic output without changing test results', () => {
    console.log('holonomy console conformance', { value: 42 })
    console.warn('holonomy warning conformance')
    assert.equal(6 * 7, 42)
  })
})
