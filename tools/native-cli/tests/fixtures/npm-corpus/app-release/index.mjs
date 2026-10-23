/* eslint-disable no-console, node/prefer-global/process -- Guest CLI output and process argv are under test. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'

import * as acorn from 'acorn'
import { minimatch } from 'minimatch'
import semver from 'semver'
import YAML from 'yaml'

const argv = process.argv.slice(2)
assert.equal(process.versions.node, undefined)
assert.equal(argv.length, 4)
assert.equal(argv[0], '--range')
assert.equal(argv[2], '--path')

const releases = YAML.parse(fs.readFileSync('holo-fs://workspace/releases.yaml', 'utf8')).releases
assert.equal(releases.length, 3)
const selected = releases
  .filter(release => semver.satisfies(release.version, argv[1]) && minimatch(release.path, argv[3]))
  .map((release) => {
    const parsed = acorn.parse(release.code, { ecmaVersion: 2022 })
    assert.equal(parsed.body.length, 1)
    return { version: release.version, path: release.path }
  })

if (selected.length === 0) {
  console.error('NO_RELEASE_MATCH')
  process.exit(2)
}

assert.deepEqual(selected, [
  { version: '1.2.0', path: 'src/core.js' },
  { version: '1.5.0', path: 'src/sub/feature.js' }
])
const sha256 = createHash('sha256').update(JSON.stringify(selected)).digest('hex')
assert.equal(sha256, '98d4c78732aeb58fb9630c843c5dc18d2fd60b978fa1cfe6c97680a8e4f0fec9')
fs.writeFileSync('holo-fs://workspace/selection.json', JSON.stringify({ selected, sha256 }))
console.log('RELEASE_CLI_OK')
