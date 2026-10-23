/* eslint-disable max-lines -- Private installation validation and immutable registry share one ingress. */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { types } from 'node:util'

import { normalizeRuntimePluginBundlesV1 } from '@holonomyjs/runtime/app'
import { compileRuntimeObserverAdmissionV1 } from '@holonomyjs/runtime/kernel'
import { canonicalDigest } from '@holonomyjs/runtime/kernel/canonical-json'
import { HolonomyModuleLoader } from '@holonomyjs/runtime/module-loader/index'

import {
  NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1,
  NATIVE_RUNTIME_OBSERVER_PLATFORM_V1
} from '../../adapters/desktop/v8-host/bootstrap/native-observer-platform.mjs'
import { prepareNativeRuntimePluginEntriesV1 } from '../holonomy-native-plugin-bundle.mjs'
import { createNativeSourceReader } from '../holonomy-native-source-reader.mjs'
import { parseHoloPluginJson, validateHoloPluginOptionsValue } from '../holonomy-plugin-config.mjs'
import { serviceError } from './errors.mjs'
import {
  readServiceNativeRuntimeInstallationDetails,
  validateNativeExecutable
} from './native-runtime-installation.mjs'
import { readBoundedRegularFile } from './secure-file-read.mjs'

const PROFILE_ID = /^[A-Za-z0-9][\w.-]{0,63}$/u
const HEX_SHA256 = /^[0-9a-f]{64}$/u
const MAX_PROFILES = 4
const MAX_CONFIG_BYTES = 64 * 1024
const MAX_MODULE_BYTES = 1024 * 1024
const MAX_GRAPH_BYTES = 4 * 1024 * 1024
const MAX_MODULES = 128
const DEFAULT_SINK_BYTES = 1024 * 1024
const invalid = () => new TypeError('Native Observer profile installation is invalid')
const corrupt = () => serviceError('service.state_corrupt', 'Native Observer profile installation is invalid')

// Read only own data descriptors. This also rejects functions and accessors
// nested in caller-supplied registries before shared compilers see them.
const dataCopy = (value, state = { count: 0, seen: new Set() }, depth = 0) => {
  if (++state.count > 100_000 || depth > 64) throw invalid()
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || types.isProxy(value) || state.seen.has(value)) throw invalid()
  state.seen.add(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) throw invalid()
  let output
  if (Array.isArray(value)) {
    const length = descriptors.length?.value
    if (!Number.isSafeInteger(length) || length > 100_000) throw invalid()
    output = []
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[index]
      if (descriptor == null || !Object.hasOwn(descriptor, 'value')) throw invalid()
      output.push(dataCopy(descriptor.value, state, depth + 1))
    }
    if (Reflect.ownKeys(descriptors).length !== length + 1) throw invalid()
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw invalid()
    }
    output = Object.create(null)
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!Object.hasOwn(descriptor, 'value')) throw invalid()
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: dataCopy(descriptor.value, state, depth + 1),
        writable: true
      })
    }
  }
  state.seen.delete(value)
  return output
}

const exact = (value, allowed, required = []) => {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key)) ||
    required.some(key => !Object.hasOwn(value, key))
  ) throw invalid()
  return value
}

const normalizeRegistration = value => {
  const input = exact(value, ['acceptHighCost', 'callbackTimeoutMs', 'events', 'maxQueuedEvents'], ['events'])
  if (input.acceptHighCost !== undefined && typeof input.acceptHighCost !== 'boolean') throw invalid()
  const supported = NATIVE_RUNTIME_OBSERVER_PLATFORM_V1.events
    .filter(event => event.supportLevel !== 'unsupported')
    .map(event => event.event)
  const admitted = compileRuntimeObserverAdmissionV1(
    input,
    {
      maxObserverCallbackMs: NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1.maxObserverCallbackMs,
      maxQueuedEvents: NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1.maxQueuedEvents,
      observerEvents: supported
    },
    NATIVE_RUNTIME_OBSERVER_PLATFORM_V1,
    NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1
  )
  if (admitted.callbackTimeoutMs < 1 || admitted.maxQueuedEvents < 1) throw invalid()
  return Object.freeze({
    ...(input.acceptHighCost === true ? { acceptHighCost: true } : {}),
    callbackTimeoutMs: admitted.callbackTimeoutMs,
    events: Object.freeze([...admitted.events]),
    maxQueuedEvents: admitted.maxQueuedEvents
  })
}

const normalizeSink = value => {
  const input = exact(value === undefined ? {} : value, ['maxBytes'])
  const maxBytes = input.maxBytes === undefined ? DEFAULT_SINK_BYTES : input.maxBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16 * 1024 * 1024) {
    throw invalid()
  }
  return Object.freeze({ maxBytes })
}

const normalizeBundle = (id, value) => {
  const [bundle] = normalizeRuntimePluginBundlesV1([value])
  const rootUrl = `holo-plugins:///observer.${id}/`
  if (
    bundle.instanceId !== `observer.${id}` || bundle.rootUrl !== rootUrl ||
    !bundle.entryUrl.startsWith(rootUrl) || bundle.files.length > MAX_MODULES ||
    Buffer.byteLength(JSON.stringify(bundle.config), 'utf8') > MAX_CONFIG_BYTES
  ) throw invalid()
  if (bundle.configSchema !== undefined) {
    validateHoloPluginOptionsValue(bundle.configSchema, bundle.config)
  }
  let bytes = 0
  for (const file of bundle.files) {
    const size = Buffer.byteLength(file.source, 'utf8')
    bytes += size
    if (size > MAX_MODULE_BYTES || bytes > MAX_GRAPH_BYTES) throw invalid()
  }
  return bundle
}

export const normalizeServiceNativeObserverProfilesV1 = input => {
  if (input === null) throw invalid()
  if (types.isProxy(input)) throw invalid()
  if (
    input != null && !(input instanceof Map) &&
    (typeof input !== 'object' || Array.isArray(input))
  ) throw invalid()
  const entries = input instanceof Map
    ? [...Map.prototype.entries.call(input)]
    : Object.entries(dataCopy(input ?? {}))
  if (entries.length > MAX_PROFILES) throw invalid()
  const registry = new Map()
  let totalBytes = 0
  let totalFiles = 0
  for (const [id, descriptor] of entries) {
    if (typeof id !== 'string' || !PROFILE_ID.test(id) || registry.has(id)) throw invalid()
    const profile = exact(dataCopy(descriptor), ['bundle', 'registration', 'sink', 'version'], [
      'bundle',
      'registration'
    ])
    const bundle = normalizeBundle(id, profile.bundle)
    const registration = normalizeRegistration(profile.registration)
    const sink = normalizeSink(profile.sink)
    totalFiles += bundle.files.length
    totalBytes += bundle.files.reduce((sum, file) => sum + Buffer.byteLength(file.source, 'utf8'), 0)
    if (totalFiles > MAX_MODULES || totalBytes > MAX_GRAPH_BYTES) throw invalid()
    const version = canonicalDigest({ id, bundle, registration, sink })
    if (
      profile.version !== undefined && (typeof profile.version !== 'string' ||
        !HEX_SHA256.test(profile.version) || profile.version !== version)
    ) throw invalid()
    registry.set(id, Object.freeze({ bundle, registration, sink, version }))
  }
  return registry
}

const validateManifest = value => {
  const manifest = exact(value, ['pluginRoots', 'profiles', 'schemaVersion'], ['profiles', 'schemaVersion'])
  if (manifest.schemaVersion !== 1) throw invalid()
  const pluginRoots = manifest.pluginRoots === undefined ? [] : manifest.pluginRoots
  if (
    !Array.isArray(pluginRoots) || pluginRoots.length > 16 ||
    pluginRoots.some(root =>
      typeof root !== 'string' || !isAbsolute(root) ||
      root.length > 4096 || resolve(root) !== root
    )
  ) throw invalid()
  const profiles = exact(manifest.profiles, Object.keys(manifest.profiles))
  if (Object.keys(profiles).length > MAX_PROFILES) throw invalid()
  const entries = []
  const metadata = new Map()
  for (const [id, raw] of Object.entries(profiles)) {
    if (!PROFILE_ID.test(id)) throw invalid()
    const profile = exact(raw, ['config', 'export', 'integrity', 'registration', 'sink', 'use'], [
      'registration',
      'use'
    ])
    if (profile.export === null || profile.integrity === null || profile.config === null) throw invalid()
    const registration = normalizeRegistration(profile.registration)
    const sink = normalizeSink(profile.sink)
    const entry = {
      config: profile.config ?? {},
      ...(profile.export === undefined ? {} : { export: profile.export }),
      id: `observer.${id}`,
      ...(profile.integrity === undefined ? {} : { integrity: profile.integrity }),
      use: profile.use
    }
    if (Buffer.byteLength(JSON.stringify(entry.config), 'utf8') > MAX_CONFIG_BYTES) throw invalid()
    entries.push(entry)
    metadata.set(id, { registration, sink })
  }
  return { entries, metadata, pluginRoots }
}

const validateEsmClosure = async bundle => {
  const files = new Map(bundle.files.map(file => [file.url, file]))
  // Materialization writes this package scope. It is metadata only; no source
  // module is synthesized or evaluated by this preflight.
  const packageBytes = Buffer.from(JSON.stringify({ type: 'module' }))
  const packageUrl = `${bundle.rootUrl}package.json`
  const loader = new HolonomyModuleLoader({
    readModule: url => {
      if (url === packageUrl) {
        return { bytes: packageBytes, sha256: createHash('sha256').update(packageBytes).digest('hex') }
      }
      const file = files.get(url)
      return file == null ? null : { bytes: Buffer.from(file.source, 'utf8'), sha256: file.sha256 }
    },
    syntheticNodeModules: Object.freeze(Object.create(null))
  }, {
    limits: { maxModules: MAX_MODULES, maxSourceBytes: MAX_MODULE_BYTES, maxTotalSourceBytesPerPlan: MAX_GRAPH_BYTES },
    rootUrl: bundle.rootUrl
  })
  const plan = await loader.createPlan(bundle.entryUrl)
  if (
    plan.modules.some(module =>
      module.format !== 'module' || module.source === null ||
      module.sha256 === null || !files.has(module.url) ||
      module.dependencies.some(dependency => dependency.kind !== 'import')
    )
  ) throw invalid()
  const entry = plan.modules.find(module => module.url === bundle.entryUrl)
  if (entry == null || !entry.exportNames.includes(bundle.exportName)) throw invalid()
}

// A caller-owned reader shares its Native role ledger with Guest closure
// collection. Only a reader created here is closed by this function.
export const readServiceNativeObserverProfilesV1 = async (home, { binaryPath, reader: providedReader } = {}) => {
  const manifestPath = join(home, 'native-observer-profiles.json')
  let bytes
  try {
    bytes = await readBoundedRegularFile(manifestPath, {
      label: 'Native Observer profile installation',
      maxBytes: 1024 * 1024,
      ownerOnly: true,
      ownerUid: process.getuid?.()
    })
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map()
    throw corrupt()
  }
  let ownedReader
  try {
    const manifest = parseHoloPluginJson(bytes, 'Native Observer profile installation')
    const { entries, metadata, pluginRoots } = validateManifest(manifest)
    if (
      providedReader != null && (
        typeof providedReader.capturePrivate !== 'function' ||
        typeof providedReader.readPrivate !== 'function' ||
        typeof providedReader.statPrivate !== 'function' ||
        typeof providedReader.openPrivatePackage !== 'function' ||
        typeof providedReader.readPrivatePackage !== 'function'
      )
    ) throw invalid()
    if (providedReader == null) {
      const selectedBinary = binaryPath ??
        (await readServiceNativeRuntimeInstallationDetails(home))?.executablePath
      if (selectedBinary == null) throw invalid()
      ownedReader = await createNativeSourceReader({
        binaryPath: await validateNativeExecutable(selectedBinary),
        workspaceRoot: home
      })
    }
    const reader = providedReader ?? ownedReader
    await reader.capturePrivate(manifestPath)
    const captured = await reader.readPrivate(manifestPath, 'config')
    if (captured == null || captured.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
      throw invalid()
    }
    if (entries.length === 0) return new Map()
    const prepared = await prepareNativeRuntimePluginEntriesV1(entries, {
      reader,
      configPath: manifestPath,
      allowedAbsoluteRoots: pluginRoots,
      limits: { maxModules: MAX_MODULES, maxFileBytes: MAX_MODULE_BYTES, maxGraphBytes: MAX_GRAPH_BYTES }
    })
    const profiles = new Map()
    for (const [id, details] of metadata) {
      const bundle = prepared.bundles.find(item => item.instanceId === `observer.${id}`)
      if (bundle == null) throw invalid()
      await validateEsmClosure(bundle)
      profiles.set(id, { bundle, ...details })
    }
    return normalizeServiceNativeObserverProfilesV1(profiles)
  } catch {
    throw corrupt()
  } finally {
    await ownedReader?.close().catch(() => undefined)
  }
}
