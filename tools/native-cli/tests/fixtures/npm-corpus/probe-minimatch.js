/* eslint-disable no-console -- Guest stdout is the Native CLI assertion marker. */
const assert = require('node:assert/strict')
const minimatch = require('minimatch')
assert.strictEqual(minimatch.minimatch('a.ts', '{a,b}.ts'), true)
console.log('MINIMATCH_OK')
