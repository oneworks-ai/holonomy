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

  it('exposes a canonical external module URL', () => {
    const url = new URL(import.meta.url)
    assert.equal(url.href, import.meta.url)
    assert.ok(url.pathname.endsWith('/node-modules.test.mjs'))
    assert.notEqual(url.protocol, 'holonomy:')
    assert.notEqual(url.protocol, 'holo-plugins:')
  })
})

describe.holonomy.android('Android process', () => {
  it('reports the Android process platform', () => {
    assert.equal(process.platform, 'android')
  })
})
