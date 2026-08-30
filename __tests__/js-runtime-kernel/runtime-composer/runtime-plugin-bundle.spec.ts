import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { normalizeRuntimePluginBundlesV1, runtimePluginBundleDigestV1 } from '../../../src/runtime/plugin-bundle.js'

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

const bundle = (source = 'export default () => undefined') => {
  const value = {
    config: {},
    entryUrl: 'holo-plugins:///plugin/index.mjs' as const,
    exportName: 'default',
    files: [{ sha256: sha256(source), source, url: 'holo-plugins:///plugin/index.mjs' as const }],
    instanceId: 'plugin',
    rootUrl: 'holo-plugins:///plugin/' as const,
    schemaVersion: 1 as const
  }
  return { ...value, bundleSha256: runtimePluginBundleDigestV1(value) }
}

describe('runtime Plugin source-only Bundle v1', () => {
  it('accepts strict UTF-8 source and preserves its exact digest', () => {
    const source = 'export default () => "插件"'
    const [normalized] = normalizeRuntimePluginBundlesV1([bundle(source)])
    expect(normalized?.files[0]).toMatchObject({ sha256: sha256(source), source })
  })

  it('rejects non-scalar JSON strings before replacement characters can alias the digest', () => {
    expect(() => normalizeRuntimePluginBundlesV1([bundle('export default "\uD800"')]))
      .toThrow('Unicode scalar text')
  })

  it('rejects a Bundle with more than 512 source files', () => {
    const value = bundle()
    expect(() =>
      normalizeRuntimePluginBundlesV1([{
        ...value,
        files: Array.from({ length: 513 }, (_, index) => ({
          sha256: sha256(''),
          source: '',
          url: `holo-plugins:///plugin/${index}.mjs`
        }))
      }])
    ).toThrow('version or files are invalid')
  })
})
