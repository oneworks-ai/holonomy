/* eslint-disable no-console -- Guest stdout is the Native CLI assertion marker. */
const assert = require('node:assert/strict')
const semver = require('semver/index.js')
assert.strictEqual(semver.valid('1.2.3'), '1.2.3')
assert.strictEqual(semver.satisfies('1.2.3', '^1.2.0'), true)
console.log('SEMVER_DEEP_OK')
