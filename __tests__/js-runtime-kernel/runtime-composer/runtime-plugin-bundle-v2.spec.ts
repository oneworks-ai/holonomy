import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  normalizeRuntimePluginBundles,
  normalizeRuntimePluginBundlesV2,
  runtimePluginBundleDigestV2
} from '../../../packages/runtime/src/app/plugin-bundle-v2.js'
import type { RuntimePluginBundleV2 } from '../../../packages/runtime/src/app/plugin-types.js'

const root = 'holo-plugins:///gate/' as const
const source = (url: string, text: string) => {
  const bytes = Buffer.from(text)
  return {
    url,
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytesBase64: bytes.toString('base64')
  }
}
const bundle = () => {
  const raw: Omit<RuntimePluginBundleV2, 'bundleSha256'> = {
    config: { enabled: true },
    entryUrl: `${root}gate.mjs` as const,
    exportName: 'default',
    instanceId: 'gate',
    rootUrl: root,
    schemaVersion: 2 as const,
    sourceClosure: {
      kind: 'source-closure' as const,
      entryUrl: `${root}gate.mjs`,
      rootUrl: root,
      reads: [
        source(`${root}gate.mjs`, "import {value} from 'dep'; export default ()=>value"),
        source(`${root}node_modules/.pnpm/dep@1/node_modules/dep/index.mjs`, 'export const value=1'),
        source(
          `${root}node_modules/.pnpm/dep@1/node_modules/dep/package.json`,
          '{"exports":"./index.mjs","type":"module"}'
        )
      ],
      aliases: [
        {
          url: `${root}node_modules/dep/index.mjs`,
          canonicalUrl: `${root}node_modules/.pnpm/dep@1/node_modules/dep/index.mjs`
        },
        {
          url: `${root}node_modules/dep/package.json`,
          canonicalUrl: `${root}node_modules/.pnpm/dep@1/node_modules/dep/package.json`
        }
      ],
      externalReferences: []
    }
  }
  return { ...raw, bundleSha256: runtimePluginBundleDigestV2(raw) }
}

describe('runtime plugin Bundle V2', () => {
  it('preserves one canonical pnpm dependency and metadata with an immutable digest', () => {
    const candidate = bundle()
    const [normalized] = normalizeRuntimePluginBundlesV2([candidate])
    expect(normalized).toEqual(candidate)
    expect(Object.isFrozen(normalized?.sourceClosure.reads)).toBe(true)
    expect(normalizeRuntimePluginBundles([candidate])[0]).toEqual(candidate)
  })

  it('rejects tampered bytes, external references, invalid aliases and query identities', () => {
    const candidate = bundle()
    const invalid = [
      {
        ...candidate,
        sourceClosure: {
          ...candidate.sourceClosure,
          reads: [
            { ...candidate.sourceClosure.reads[0], bytesBase64: Buffer.from('changed').toString('base64') },
            ...candidate.sourceClosure.reads.slice(1)
          ]
        }
      },
      {
        ...candidate,
        sourceClosure: {
          ...candidate.sourceClosure,
          externalReferences: [{
            kind: 'import',
            parentUrl: candidate.entryUrl,
            specifier: 'node:fs',
            url: 'node:fs'
          }]
        }
      },
      {
        ...candidate,
        sourceClosure: {
          ...candidate.sourceClosure,
          aliases: [
            { ...candidate.sourceClosure.aliases[0], canonicalUrl: `${root}absent.mjs` },
            candidate.sourceClosure.aliases[1]
          ]
        }
      },
      {
        ...candidate,
        sourceClosure: {
          ...candidate.sourceClosure,
          reads: [
            { ...candidate.sourceClosure.reads[0], url: `${root}gate.mjs?one` },
            ...candidate.sourceClosure.reads.slice(1)
          ]
        }
      }
    ]
    for (const item of invalid) expect(() => normalizeRuntimePluginBundlesV2([item])).toThrow()
  })

  it('keeps V1 strict while rejecting cross-version instance ID collisions', () => {
    const candidate: RuntimePluginBundleV2 = bundle()
    expect(() => normalizeRuntimePluginBundlesV2([{ ...candidate, unexpected: true }])).toThrow()
    expect(() => normalizeRuntimePluginBundles([candidate, candidate])).toThrow()
  })

  it('accepts an exact 8 MiB read without a base64 RegExp stack limit', () => {
    const candidate = bundle()
    const maximum = source(candidate.entryUrl, 'A'.repeat(8 * 1024 * 1024))
    const raw: Omit<RuntimePluginBundleV2, 'bundleSha256'> = {
      ...candidate,
      sourceClosure: {
        ...candidate.sourceClosure,
        reads: [maximum],
        aliases: []
      }
    }
    const accepted = normalizeRuntimePluginBundlesV2([{
      ...raw,
      bundleSha256: runtimePluginBundleDigestV2(raw)
    }])
    expect(accepted[0]?.sourceClosure.reads[0]?.byteLength).toBe(8 * 1024 * 1024)

    const invalid = {
      ...maximum,
      bytesBase64: `${maximum.bytesBase64.slice(0, -2)}!${maximum.bytesBase64.slice(-1)}`
    }
    expect(() =>
      normalizeRuntimePluginBundlesV2([{
        ...raw,
        sourceClosure: { ...raw.sourceClosure, reads: [invalid] },
        bundleSha256: runtimePluginBundleDigestV2(raw)
      }])
    ).toThrow('Runtime plugin source digest is invalid')
  })
})
