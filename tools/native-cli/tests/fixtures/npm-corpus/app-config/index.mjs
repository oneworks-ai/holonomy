/* eslint-disable no-console, node/prefer-global/process -- Guest CLI output and argv are under test. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'

import { parseDocument } from 'yaml'

assert.equal(process.versions.node, undefined)
const [input, environment] = process.argv.slice(2)
assert.equal(process.argv.length, 4)
assert.ok(environment === 'production' || environment === 'staging')
const document = parseDocument(fs.readFileSync(input, 'utf8'))
if (document.errors.length) {
  console.error(`CONFIG_INVALID:${document.errors[0].code}`)
  process.exit(2)
}
document.setIn(['service', 'environment'], environment)
document.setIn(['service', 'enabled'], true)
const output = String(document)
const restored = parseDocument(output).toJS()
assert.equal(restored.service.environment, environment)
assert.equal(restored.service.enabled, true)
assert.equal(restored.defaults, restored.service.retry)
assert.ok(output.includes('# deployment settings'))
assert.ok(output.includes('&retry'))
assert.ok(output.includes('*retry'))
fs.writeFileSync('holo-fs://workspace/promoted.yaml', output)
const sha256 = createHash('sha256').update(output).digest('hex')
fs.writeFileSync('holo-fs://workspace/receipt.json', JSON.stringify({ environment, sha256 }))
console.log('CONFIG_PROMOTION_OK')
