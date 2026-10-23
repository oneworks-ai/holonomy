/* eslint-disable no-console -- Guest stdout is the Native CLI assertion marker. */
const assert = require('node:assert/strict')
const semver = require('semver')
assert.strictEqual(semver.valid('1.2.3'), '1.2.3')
console.log('SEMVER_OK')
