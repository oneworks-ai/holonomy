import assert from 'node:assert/strict'
import { it } from 'vitest'

import { createNativeSourceReadAudit } from '../bootstrap/source-read-audit.mjs'

it('encodes only validated Gate primitives without replaceable Host serialization', () => {
  let encoded
  let replaced = false
  const native = {
    sourceReadAudit: value => {
      encoded = value
      return true
    }
  }
  const record = createNativeSourceReadAudit(native)
  native.sourceReadAudit = () => false
  const original = JSON.stringify
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
  let result
  try {
    JSON.stringify = () => {
      replaced = true
      throw new Error('must not serialize through Host globals')
    }
    // eslint-disable-next-line no-extend-native -- Host prototype tamper regression; restored in finally.
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value() {
        replaced = true
        throw new Error('must not invoke Host toJSON')
      }
    })
    result = record({ codeKind: 'wasm', requestId: 9, sourceBytes: 8, sourceSha256: 'a'.repeat(64) }, 8)
  } finally {
    JSON.stringify = original
    if (descriptor == null) delete Object.prototype.toJSON
    // eslint-disable-next-line no-extend-native -- Restore the exact prior Host descriptor.
    else Object.defineProperty(Object.prototype, 'toJSON', descriptor)
  }
  assert.equal(result, true)
  assert.equal(replaced, false)
  assert.deepEqual(JSON.parse(encoded), {
    codeKind: 'wasm',
    readBytes: 8,
    requestId: 9,
    sourceBytes: 8,
    sourceSha256: 'a'.repeat(64)
  })
})
