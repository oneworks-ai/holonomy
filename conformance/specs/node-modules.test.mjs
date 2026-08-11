import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import process from 'node:process'
import { describe, it } from 'node:test'

describe('Node modules', () => {
  it('executes node:path behavior', () => {
    assert.equal(path.join('plugins', 'example', 'index.js'), 'plugins/example/index.js')
  })

  it('executes node:buffer behavior', () => {
    assert.equal(Buffer.from('Holonomy').toString('base64'), 'SG9sb25vbXk=')
  })

  it('preserves the external module URL', () => {
    assert.equal(import.meta.url, 'app+local://workspace/conformance/specs/node-modules.test.mjs')
  })
})

describe.holonomy.android('Android process', () => {
  it('reports the Android process platform', () => {
    assert.equal(process.platform, 'android')
  })
})
