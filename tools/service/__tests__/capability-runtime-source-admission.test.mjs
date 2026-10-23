import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { assertCapabilityDynamicImportPolicyV1 } from '../capability-runtime-admission-support.mjs'

const root = 'app://workspace/'

describe('capability runtime source classification', () => {
  it('admits package metadata and ordinary JSON without interpreting their text as JavaScript', () => {
    for (const metadataOnly of [undefined, true]) {
      const module = {
        ...(metadataOnly === undefined ? {} : { metadataOnly }),
        source: '{"type":"module","text":"import(secret)"}',
        url: `${root}package.json`
      }
      assert.doesNotThrow(() => assertCapabilityDynamicImportPolicyV1([module], false))
    }
    assert.doesNotThrow(() =>
      assertCapabilityDynamicImportPolicyV1([
        { source: '[1,2,3]', url: `${root}data.json?version=1` }
      ], false)
    )
    assert.doesNotThrow(() =>
      assertCapabilityDynamicImportPolicyV1([
        { source: '{"type":"module"}', url: `${root}data.JSON` }
      ], false)
    )
  })

  it('still rejects malformed JSON before Runtime launch', () => {
    assert.throws(() =>
      assertCapabilityDynamicImportPolicyV1([
        { metadataOnly: true, source: '{"type":', url: `${root}package.json` }
      ], false), error => error.code === 'service.invalid_request')
  })

  it('matches the Loader single-BOM rule without rewriting the retained source', () => {
    const module = { source: '\uFEFF{"type":"module"}', url: `${root}data.JSON` }
    assert.doesNotThrow(() => assertCapabilityDynamicImportPolicyV1([module], false))
    assert.equal(module.source, '\uFEFF{"type":"module"}')
    assert.throws(() =>
      assertCapabilityDynamicImportPolicyV1([
        { ...module, source: `\uFEFF${module.source}` }
      ], false), error => error.code === 'service.invalid_request')
  })

  it('does not let a restriction bit hide JavaScript dynamic imports', () => {
    const source = { metadataOnly: true, source: 'await import(name)', url: `${root}main.mjs` }
    assert.throws(
      () => assertCapabilityDynamicImportPolicyV1([source], false),
      error => error.code === 'sandbox.capability_unsupported'
    )
    assert.doesNotThrow(() => assertCapabilityDynamicImportPolicyV1([source], true))
  })
})
