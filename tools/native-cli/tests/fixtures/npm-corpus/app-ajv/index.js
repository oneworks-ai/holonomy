/* eslint-disable no-console -- Guest stdout is the Native corpus marker. */
const assert = require('node:assert/strict')
const Ajv = require('ajv')

const ajv = new Ajv()
const validate = ajv.compile({
  type: 'object',
  properties: { name: { type: 'string' }, count: { type: 'integer', minimum: 1 } },
  required: ['name', 'count'],
  additionalProperties: false
})
assert.equal(validate({ name: 'example', count: 3 }), true)
assert.equal(validate({ name: 'example', count: 0 }), false)
assert.equal(validate.errors[0].keyword, 'minimum')
console.log('AJV_APP_OK')
