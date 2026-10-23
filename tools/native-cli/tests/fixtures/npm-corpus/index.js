/* eslint-disable no-console, node/prefer-global/process -- Guest stdout and process identity are asserted on Native. */
const assert = require('node:assert/strict')
const minimatch = require('minimatch')
const minimatchAgain = require('minimatch')
const semver = require('semver')
const semverAgain = require('semver')

assert.strictEqual(globalThis.process.versions.node, undefined)
assert.ok(globalThis.process.versions.v8)
assert.strictEqual(semver, semverAgain)
assert.strictEqual(minimatch, minimatchAgain)
assert.ok(require.resolve('minimatch').endsWith('/dist/commonjs/index.js'))
assert.strictEqual(semver.valid('1.2.3'), '1.2.3')
assert.strictEqual(semver.satisfies('1.2.3', '^1.2.0'), true)
assert.strictEqual(semver.satisfies('2.0.0', '^1.2.0'), false)
assert.strictEqual(minimatch.minimatch('src/a.ts', 'src/{a,b}.ts'), true)
assert.strictEqual(minimatch.minimatch('src/c.ts', 'src/{a,b}.ts'), false)

import('./esm-entry.mjs').then(() => {
  console.log('NPM_CORPUS_OK')
})
