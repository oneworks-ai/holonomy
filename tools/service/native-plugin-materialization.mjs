import { Buffer } from 'node:buffer'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// eslint-disable-next-line antfu/no-import-dist
import { normalizeRuntimePluginBundles } from '../../dist/runtime/index.js'

import { serviceError } from './errors.mjs'

const ROOT = 'holo-plugins:///'
export const MAX_NATIVE_PLUGIN_GENERATION_BYTES = 256 * 1024 * 1024
export const MAX_NATIVE_PLUGIN_GENERATION_GRAPHS = 256
const invalid = () => {
  throw serviceError('service.invalid_request', 'Native plugin source path is invalid')
}

const fileSegments = (bundle, url) => {
  if (!url.startsWith(bundle.rootUrl) || !url.startsWith(ROOT)) invalid()
  const tail = url.slice(bundle.rootUrl.length)
  if (tail.length === 0 || tail.length > 4_096) invalid()
  const segments = tail.split('/').map(segment => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return invalid()
    }
  })
  if (
    segments.some(segment =>
      segment.length === 0 || segment === '.' || segment === '..' || segment.includes('/') ||
      segment.includes('\\') || segment.includes('\0') || segment !== segment.normalize('NFC')
    )
  ) invalid()
  const canonical = new URL(bundle.rootUrl)
  canonical.pathname = `/${bundle.instanceId}/${segments.map(segment => segment.replaceAll('%', '%25')).join('/')}`
  if (canonical.href !== url) invalid()
  return segments
}

export const materializeNativePluginGraph = async (
  hostRoot,
  revision,
  input,
  remainingBytes = MAX_NATIVE_PLUGIN_GENERATION_BYTES
) => {
  const bundles = normalizeRuntimePluginBundles(input)
  const bytes = bundles.reduce((total, bundle) =>
    total + 4_096 +
    (bundle.schemaVersion === 1
      ? bundle.files.reduce((sum, file) => sum + Buffer.byteLength(file.source, 'utf8'), 0)
      : bundle.sourceClosure.reads.reduce((sum, read) => sum + read.byteLength, 0) +
        Buffer.byteLength(
          JSON.stringify({
            schemaVersion: 2,
            instanceId: bundle.instanceId,
            rootUrl: bundle.rootUrl,
            entryUrl: bundle.entryUrl,
            bundleSha256: bundle.bundleSha256,
            reads: bundle.sourceClosure.reads.map(({ url, byteLength, sha256 }) => ({ url, byteLength, sha256 })),
            aliases: bundle.sourceClosure.aliases,
            externalReferences: [],
            ...(bundle.configSchema === undefined ? {} : { configSchema: bundle.configSchema })
          }),
          'utf8'
        )) +
    (bundle.configSchema === undefined ? 0 : Buffer.byteLength(JSON.stringify(bundle.configSchema), 'utf8')), 0)
  if (bytes > remainingBytes) {
    throw serviceError('service.limit_exceeded', 'Native plugin generation source budget is exhausted')
  }
  const directory = join(hostRoot, 'plugin-graphs', `r${revision}`)
  const plugins = []
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    for (const bundle of bundles) {
      const root = join(directory, bundle.instanceId)
      await mkdir(root, { mode: 0o700 })
      if (bundle.schemaVersion === 2) {
        const sources = join(root, 'sources')
        await mkdir(sources, { mode: 0o700 })
        for (const read of bundle.sourceClosure.reads) {
          const segments = fileSegments(bundle, read.url)
          const destination = join(sources, ...segments)
          await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 })
          await writeFile(destination, Buffer.from(read.bytesBase64, 'base64'), { flag: 'wx', mode: 0o400 })
        }
        const sidecar = {
          schemaVersion: 2,
          instanceId: bundle.instanceId,
          rootUrl: bundle.rootUrl,
          entryUrl: bundle.entryUrl,
          bundleSha256: bundle.bundleSha256,
          reads: bundle.sourceClosure.reads.map(({ url, byteLength, sha256 }) => ({ url, byteLength, sha256 })),
          aliases: bundle.sourceClosure.aliases,
          externalReferences: [],
          ...(bundle.configSchema === undefined ? {} : { configSchema: bundle.configSchema })
        }
        const sidecarText = JSON.stringify(sidecar)
        if (Buffer.byteLength(sidecarText, 'utf8') > 4 * 1024 * 1024) {
          throw serviceError('service.limit_exceeded', 'Native plugin source graph sidecar exceeds its limit')
        }
        await writeFile(join(root, 'source-graph.json'), sidecarText, { flag: 'wx', mode: 0o400 })
        plugins.push({
          config: bundle.config,
          export: bundle.exportName,
          id: bundle.instanceId,
          integrity: bundle.bundleSha256,
          sourceGraph: `./plugin-graphs/r${revision}/${bundle.instanceId}/source-graph.json`,
          use: `./plugin-graphs/r${revision}/${bundle.instanceId}/sources/${
            fileSegments(bundle, bundle.entryUrl).join('/')
          }`
        })
        continue
      }
      const seen = new Set(['package.json', 'schema.json'])
      for (const file of bundle.files) {
        const segments = fileSegments(bundle, file.url)
        const key = segments.join('/').toLowerCase()
        if (seen.has(key)) invalid()
        seen.add(key)
        const destination = join(root, ...segments)
        await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 })
        await writeFile(destination, file.source, { flag: 'wx', mode: 0o600 })
      }
      const entry = fileSegments(bundle, bundle.entryUrl).join('/')
      if (bundle.configSchema !== undefined) {
        await writeFile(join(root, 'schema.json'), JSON.stringify(bundle.configSchema), { flag: 'wx', mode: 0o600 })
      }
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          type: 'module',
          holo: {
            apiVersion: 1,
            entry,
            kind: 'runtime-plugin',
            ...(bundle.configSchema === undefined ? {} : { configSchema: './schema.json' })
          }
        }),
        { flag: 'wx', mode: 0o600 }
      )
      plugins.push({
        config: bundle.config,
        export: bundle.exportName,
        id: bundle.instanceId,
        integrity: bundle.bundleSha256,
        use: `./plugin-graphs/r${revision}/${bundle.instanceId}/package.json`
      })
    }
    return { bytes, directory, plugins }
  } catch (error) {
    await rm(directory, { force: true, recursive: true }).catch(() => undefined)
    throw error
  }
}

export const replaceNativePluginConfig = async (hostRoot, configuration) => {
  const path = join(hostRoot, 'host.json')
  const temporary = join(hostRoot, `host-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  const encoded = JSON.stringify(configuration)
  if (Buffer.byteLength(encoded, 'utf8') > 1024 * 1024) {
    throw serviceError('service.limit_exceeded', 'Native Host configuration exceeds the byte limit')
  }
  try {
    await writeFile(temporary, encoded, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
  return path
}
