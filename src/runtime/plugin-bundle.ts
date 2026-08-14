import { canonicalDigest } from '../capability-runtime/canonical-json.js'
import { sha256Hex } from '../module-loader/sha256.js'
import { encodeUtf8 } from '../node-compat/utf8.js'
import { cloneRuntimePluginJsonV1, normalizeRuntimePluginDefinitionsV1 } from './plugin-contract.js'
import type { RuntimePluginBundleV1, RuntimePluginDefinitionV1, RuntimePluginFileV1 } from './plugin-types.js'

const SHA256 = /^[a-f\d]{64}$/u

const exact = (value: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Runtime plugin ${label} must be an object`)
  }
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !keys.includes(key))) {
    throw new TypeError(`Runtime plugin ${label} contains an unknown field`)
  }
  return input
}

export const runtimePluginBundleDigestV1 = (
  bundle: Omit<RuntimePluginBundleV1, 'bundleSha256'>
): string =>
  canonicalDigest({
    config: bundle.config,
    entryUrl: bundle.entryUrl,
    exportName: bundle.exportName,
    files: bundle.files.map(file => ({ sha256: file.sha256, url: file.url })),
    instanceId: bundle.instanceId,
    rootUrl: bundle.rootUrl,
    schemaVersion: 1
  })

export const normalizeRuntimePluginBundlesV1 = (
  value: unknown
): readonly RuntimePluginBundleV1[] => {
  if (!Array.isArray(value) || value.length > 128) {
    throw new TypeError('Runtime plugin Bundles must be a bounded array')
  }
  const definitions: RuntimePluginDefinitionV1[] = []
  const bundles = value.map(item => {
    const input = exact(
      item,
      ['bundleSha256', 'config', 'entryUrl', 'exportName', 'files', 'instanceId', 'rootUrl', 'schemaVersion'],
      'Bundle'
    )
    if (input.schemaVersion !== 1 || !Array.isArray(input.files) || input.files.length === 0) {
      throw new TypeError('Runtime plugin Bundle version or files are invalid')
    }
    const [definition] = normalizeRuntimePluginDefinitionsV1([{
      bundleSha256: input.bundleSha256,
      config: input.config,
      entryUrl: input.entryUrl,
      exportName: input.exportName,
      instanceId: input.instanceId
    }])
    const rootUrl = input.rootUrl
    if (
      typeof rootUrl !== 'string' || rootUrl !== `holo-plugins:///${definition!.instanceId}/` ||
      new URL(rootUrl).href !== rootUrl
    ) throw new TypeError('Runtime plugin Bundle root URL is invalid')
    const urls = new Set<string>()
    const files = Object.freeze(input.files.map(item => {
      const file = exact(item, ['sha256', 'source', 'url'], 'file')
      if (
        typeof file.url !== 'string' || !file.url.startsWith(rootUrl) ||
        new URL(file.url).href !== file.url || urls.has(file.url)
      ) throw new TypeError('Runtime plugin file URL is invalid or duplicated')
      if (
        typeof file.source !== 'string' || typeof file.sha256 !== 'string' ||
        !SHA256.test(file.sha256) || sha256Hex(encodeUtf8(file.source)) !== file.sha256
      ) throw new TypeError('Runtime plugin file digest is invalid')
      urls.add(file.url)
      return Object.freeze({
        sha256: file.sha256,
        source: file.source,
        url: file.url as `holo-plugins:///${string}`
      }) satisfies RuntimePluginFileV1
    }))
    if (!urls.has(definition!.entryUrl)) throw new TypeError('Runtime plugin entry file is absent')
    const normalized = Object.freeze({
      ...definition!,
      files,
      rootUrl: rootUrl as `holo-plugins:///${string}/`,
      schemaVersion: 1 as const
    })
    if (runtimePluginBundleDigestV1(normalized) !== definition!.bundleSha256) {
      throw new TypeError('Runtime plugin Bundle digest is invalid')
    }
    definitions.push(definition!)
    return normalized
  })
  normalizeRuntimePluginDefinitionsV1(definitions)
  return Object.freeze(bundles)
}

export const runtimePluginDefinitionsFromBundlesV1 = (
  bundles: readonly RuntimePluginBundleV1[]
): readonly RuntimePluginDefinitionV1[] =>
  Object.freeze(bundles.map(bundle =>
    Object.freeze({
      bundleSha256: bundle.bundleSha256,
      config: cloneRuntimePluginJsonV1(bundle.config),
      entryUrl: bundle.entryUrl,
      exportName: bundle.exportName,
      instanceId: bundle.instanceId
    })
  ))
