import { Buffer } from 'node:buffer'

import { normalizeRuntimePluginBundlesV1 } from '../../../dist/runtime/index.js'

const MAX_MODULES = 512
const MAX_MODULE_BYTES = 8 * 1024 * 1024
const MAX_MODULE_GRAPH_BYTES = 48 * 1024 * 1024

const invalid = message => {
  throw new TypeError(message)
}

export const readNodeRuntimePluginsV1 = (value, state, validateUrl) => {
  const bundles = normalizeRuntimePluginBundlesV1(value ?? [])
  for (const bundle of bundles) {
    for (const file of bundle.files) {
      const sourceBytes = Buffer.byteLength(file.source)
      state.bytes += sourceBytes
      state.count += 1
      if (sourceBytes > MAX_MODULE_BYTES || state.bytes > MAX_MODULE_GRAPH_BYTES || state.count > MAX_MODULES) {
        invalid('Node Runtime module graph exceeds the limit')
      }
      validateUrl(file.url, 'plugin')
      if (state.urls.has(file.url)) invalid('Duplicate Node Runtime module URL')
      state.urls.add(file.url)
    }
  }
  return bundles
}

export const normalizeNodeRuntimePluginUpdateV1 = value => normalizeRuntimePluginBundlesV1(value)
