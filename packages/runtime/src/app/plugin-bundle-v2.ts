/* eslint-disable max-lines -- V2 validates original bytes, aliases, metadata and digest as one transaction. */
import { canonicalDigest } from '@holonomyjs/runtime/kernel/canonical-json'
import { sha256Hex } from '../module-loader/sha256.js'
import type { ModuleSourceClosure, ModuleSourceClosureAlias, ModuleSourceClosureRead } from '../module-loader/types.js'
import { decodeBase64, decodeUtf8, encodeBase64, encodeUtf8 } from '../node-compat/encoding.js'
import { normalizeRuntimePluginBundlesV1 } from './plugin-bundle.js'
import { cloneRuntimePluginJsonV1, normalizeRuntimePluginDefinitionsV1 } from './plugin-contract.js'
import type { RuntimePluginBundle, RuntimePluginBundleV2, RuntimePluginDefinitionV1 } from './plugin-types.js'

const SHA256 = /^[a-f\d]{64}$/u
const MAX_READS = 512
const MAX_ALIASES = 512
const MAX_ALIAS_BYTES = 256 * 1024
const MAX_SOURCE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const compareCodeUnits = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const exact = (value: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Runtime plugin ${label} must be an object`)
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !keys.includes(key))) {
    throw new TypeError(`Runtime plugin ${label} contains an unknown field`)
  }
  return record
}

const resourcePath = (value: unknown, rootUrl: string): string => {
  if (
    typeof value !== 'string' || value.length > 4_096 || encodeUtf8(value).length > 4_096 ||
    !value.startsWith(rootUrl)
  ) {
    throw new TypeError('Runtime plugin source URL is invalid')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('Runtime plugin source URL is invalid')
  }
  if (
    url.href !== value || url.protocol !== 'holo-plugins:' || url.host !== '' ||
    url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
  ) throw new TypeError('Runtime plugin source URL is invalid')
  const tail = url.pathname.slice(new URL(rootUrl).pathname.length)
  if (tail === '' || tail.length > 4_096) throw new TypeError('Runtime plugin source URL is invalid')
  const segments = tail.split('/').map(segment => {
    try {
      return decodeURIComponent(segment)
    } catch {
      throw new TypeError('Runtime plugin source URL is invalid')
    }
  })
  if (
    segments.some(segment =>
      segment === '' || segment === '.' || segment === '..' || segment.includes('/') ||
      segment.includes('\\') || segment.includes('\0') || segment !== segment.normalize('NFC')
    )
  ) throw new TypeError('Runtime plugin source URL is invalid')
  const expected = new URL(rootUrl)
  // Native's URL shim does not percent-encode assigned spaces and Unicode.
  expected.pathname += segments.map(segment => encodeURI(segment).replaceAll('?', '%3F').replaceAll('#', '%23')).join(
    '/'
  )
  if (expected.href !== value) throw new TypeError('Runtime plugin source URL is invalid')
  return segments.join('/')
}

const sourceRead = (value: unknown, rootUrl: string): ModuleSourceClosureRead => {
  const row = exact(value, ['url', 'byteLength', 'sha256', 'bytesBase64'], 'source read')
  resourcePath(row.url, rootUrl)
  if (
    !Number.isSafeInteger(row.byteLength) || (row.byteLength as number) < 0 ||
    (row.byteLength as number) > MAX_SOURCE_BYTES ||
    typeof row.sha256 !== 'string' || !SHA256.test(row.sha256) ||
    typeof row.bytesBase64 !== 'string' ||
    row.bytesBase64.length !== Math.ceil((row.byteLength as number) / 3) * 4
  ) throw new TypeError('Runtime plugin source read is invalid')
  const bytes = decodeBase64(row.bytesBase64)
  if (
    bytes.length !== row.byteLength || encodeBase64(bytes, false) !== row.bytesBase64 ||
    sha256Hex(bytes) !== row.sha256
  ) throw new TypeError('Runtime plugin source digest is invalid')
  // The pure-JS round trip rejects invalid UTF-8 and preserves an optional BOM.
  const roundtrip = encodeUtf8(decodeUtf8(bytes))
  if (roundtrip.length !== bytes.length || roundtrip.some((byte, index) => byte !== bytes[index])) {
    throw new TypeError('Runtime plugin source must be strict UTF-8')
  }
  return Object.freeze({
    byteLength: bytes.length,
    bytesBase64: row.bytesBase64,
    sha256: row.sha256,
    url: row.url
  }) as ModuleSourceClosureRead
}

const normalizedClosure = (value: unknown, rootUrl: string, entryUrl: string): ModuleSourceClosure => {
  const closure = exact(
    value,
    ['kind', 'entryUrl', 'rootUrl', 'reads', 'aliases', 'externalReferences'],
    'source closure'
  )
  if (
    closure.kind !== 'source-closure' || closure.entryUrl !== entryUrl ||
    closure.rootUrl !== rootUrl || !Array.isArray(closure.reads) ||
    closure.reads.length < 1 || closure.reads.length > MAX_READS ||
    !Array.isArray(closure.aliases) || closure.aliases.length > MAX_ALIASES ||
    !Array.isArray(closure.externalReferences) || closure.externalReferences.length !== 0
  ) throw new TypeError('Runtime plugin source closure is invalid')
  let declaredBytes = 0
  let encodedBytes = 0
  for (const item of closure.reads) {
    const read = exact(item, ['url', 'byteLength', 'sha256', 'bytesBase64'], 'source read')
    if (
      !Number.isSafeInteger(read.byteLength) || (read.byteLength as number) < 0 ||
      typeof read.bytesBase64 !== 'string'
    ) {
      throw new TypeError('Runtime plugin source read is invalid')
    }
    declaredBytes += read.byteLength as number
    encodedBytes += read.bytesBase64.length
    if (declaredBytes > MAX_TOTAL_BYTES || encodedBytes > Math.ceil(MAX_TOTAL_BYTES / 3) * 4 + MAX_READS * 4) {
      throw new TypeError('Runtime plugin source graph exceeds the encoded byte limit')
    }
  }
  const reads: ModuleSourceClosureRead[] = []
  const canonical = new Set<string>()
  const physical = new Map<string, string>()
  let bytes = 0
  for (const item of closure.reads) {
    const read = sourceRead(item, rootUrl)
    if (canonical.has(read.url) || reads.length > 0 && compareCodeUnits(reads[reads.length - 1]!.url, read.url) >= 0) {
      throw new TypeError('Runtime plugin source reads are duplicated or unsorted')
    }
    canonical.add(read.url)
    reads.push(read)
    bytes += read.byteLength
    if (bytes > MAX_TOTAL_BYTES) throw new TypeError('Runtime plugin source graph exceeds the byte limit')
    const key = resourcePath(read.url, rootUrl).toLocaleLowerCase('en-US')
    const prior = physical.get(key)
    if (prior != null && prior !== read.url) {
      throw new TypeError('Runtime plugin source physical paths collide')
    }
    physical.set(key, read.url)
  }
  if (!canonical.has(entryUrl)) throw new TypeError('Runtime plugin entry source is absent')
  const aliases: ModuleSourceClosureAlias[] = []
  const seenAliases = new Set<string>()
  const aliasPhysical = new Set<string>()
  let aliasBytes = 0
  for (const item of closure.aliases) {
    const alias = exact(item, ['url', 'canonicalUrl'], 'source alias')
    const path = resourcePath(alias.url, rootUrl)
    resourcePath(alias.canonicalUrl, rootUrl)
    if (
      alias.url === alias.canonicalUrl || canonical.has(alias.url as string) ||
      seenAliases.has(alias.url as string) || !canonical.has(alias.canonicalUrl as string) ||
      aliases.length > 0 && compareCodeUnits(aliases[aliases.length - 1]!.url, alias.url as string) >= 0 ||
      physical.has(path.toLocaleLowerCase('en-US')) ||
      aliasPhysical.has(path.toLocaleLowerCase('en-US'))
    ) throw new TypeError('Runtime plugin source alias is invalid')
    aliasBytes += encodeUtf8(alias.url as string).length + encodeUtf8(alias.canonicalUrl as string).length
    if (aliasBytes > MAX_ALIAS_BYTES) throw new TypeError('Runtime plugin source aliases exceed the byte limit')
    seenAliases.add(alias.url as string)
    aliasPhysical.add(path.toLocaleLowerCase('en-US'))
    aliases.push(Object.freeze({ url: alias.url, canonicalUrl: alias.canonicalUrl }) as ModuleSourceClosureAlias)
  }
  return Object.freeze({
    kind: 'source-closure',
    entryUrl,
    rootUrl,
    reads: Object.freeze(reads),
    aliases: Object.freeze(aliases),
    externalReferences: Object.freeze([])
  })
}

export const runtimePluginBundleDigestV2 = (bundle: Omit<RuntimePluginBundleV2, 'bundleSha256'>): string =>
  canonicalDigest({
    schemaVersion: 2,
    instanceId: bundle.instanceId,
    entryUrl: bundle.entryUrl,
    rootUrl: bundle.rootUrl,
    exportName: bundle.exportName,
    config: bundle.config,
    ...(bundle.configSchema === undefined ? {} : { configSchema: bundle.configSchema }),
    reads: bundle.sourceClosure.reads.map(read => ({
      url: read.url,
      byteLength: read.byteLength,
      sha256: read.sha256
    })),
    aliases: bundle.sourceClosure.aliases.map(alias => ({
      url: alias.url,
      canonicalUrl: alias.canonicalUrl
    })),
    externalReferences: []
  })

export const normalizeRuntimePluginBundlesV2 = (value: unknown): readonly RuntimePluginBundleV2[] => {
  if (!Array.isArray(value) || value.length > 128) {
    throw new TypeError('Runtime plugin Bundles must be a bounded array')
  }
  const definitions: RuntimePluginDefinitionV1[] = []
  const bundles = value.map(item => {
    const input = exact(item, [
      'schemaVersion',
      'instanceId',
      'entryUrl',
      'rootUrl',
      'exportName',
      'config',
      'configSchema',
      'bundleSha256',
      'sourceClosure'
    ], 'Bundle V2')
    if (input.schemaVersion !== 2) throw new TypeError('Runtime plugin Bundle V2 version is invalid')
    const [definition] = normalizeRuntimePluginDefinitionsV1([{
      instanceId: input.instanceId,
      entryUrl: input.entryUrl,
      exportName: input.exportName,
      config: input.config,
      bundleSha256: input.bundleSha256
    }])
    const rootUrl = `holo-plugins:///${definition!.instanceId}/` as `holo-plugins:///${string}/`
    if (input.rootUrl !== rootUrl) throw new TypeError('Runtime plugin Bundle V2 root URL is invalid')
    resourcePath(definition!.entryUrl, rootUrl)
    const configSchema = input.configSchema === undefined
      ? undefined
      : cloneRuntimePluginJsonV1(input.configSchema)
    if (
      configSchema !== undefined &&
      ((configSchema === null || typeof configSchema !== 'object') && typeof configSchema !== 'boolean' ||
        Array.isArray(configSchema) || encodeUtf8(JSON.stringify(configSchema)).length > 1024 * 1024)
    ) throw new TypeError('Runtime plugin config Schema is invalid or oversized')
    const normalized: RuntimePluginBundleV2 = Object.freeze({
      ...definition!,
      ...(configSchema === undefined ? {} : { configSchema }),
      rootUrl,
      schemaVersion: 2,
      sourceClosure: normalizedClosure(input.sourceClosure, rootUrl, definition!.entryUrl)
    })
    if (runtimePluginBundleDigestV2(normalized) !== definition!.bundleSha256) {
      throw new TypeError('Runtime plugin Bundle V2 digest is invalid')
    }
    definitions.push(definition!)
    return normalized
  })
  normalizeRuntimePluginDefinitionsV1(definitions)
  return Object.freeze(bundles)
}

export const normalizeRuntimePluginBundles = (value: unknown): readonly RuntimePluginBundle[] => {
  if (!Array.isArray(value) || value.length > 128) {
    throw new TypeError('Runtime plugin Bundles must be a bounded array')
  }
  const bundles = value.map(item => {
    const version = item != null && typeof item === 'object' && !Array.isArray(item)
      ? (item as { schemaVersion?: unknown }).schemaVersion
      : undefined
    if (version === 1) return normalizeRuntimePluginBundlesV1([item])[0]!
    if (version === 2) return normalizeRuntimePluginBundlesV2([item])[0]!
    throw new TypeError('Runtime plugin Bundle version is invalid')
  })
  normalizeRuntimePluginDefinitionsV1(bundles.map(bundle => ({
    bundleSha256: bundle.bundleSha256,
    config: bundle.config,
    entryUrl: bundle.entryUrl,
    exportName: bundle.exportName,
    instanceId: bundle.instanceId
  })))
  return Object.freeze(bundles)
}

export const runtimePluginDefinitionsFromBundles = (
  bundles: readonly RuntimePluginBundle[]
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
