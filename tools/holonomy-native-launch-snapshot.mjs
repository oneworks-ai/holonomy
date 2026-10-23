/* eslint-disable max-lines -- Native preflight keeps one reader lease across private capture and Guest closure. */
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { TextDecoder } from 'node:util'

import { HolonomyModuleLoader } from '@holonomyjs/runtime/module-loader/index'

import { expandHolonomyEntries } from './holonomy-module-graph.mjs'
import { prepareHolonomyRuntimePluginsNative } from './holonomy-native-plugin-bundle.mjs'
import { createNativeSourceReader } from './holonomy-native-source-reader.mjs'
import { requiresHolonomyNetworkFixture } from './holonomy-network-fixture.mjs'
import { readServiceNativeObserverProfilesV1 } from './service/native-observer-profiles.mjs'
import {
  readServiceNativeRuntimeInstallation,
  validateNativeExecutable
} from './service/native-runtime-installation.mjs'
import { resolveHolonomyHome, serviceHomePaths } from './service/service-home.mjs'

const MAX_MODULES = 512
const MAX_ALIASES = 512
const MAX_ALIAS_BYTES = 256 * 1024
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_GRAPH_BYTES = 32 * 1024 * 1024
const MAX_JSON_BYTES = 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/u
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const JSON_UTF8 = new TextDecoder('utf-8', { fatal: true })
const NATIVE_CONTEXT = Symbol('holonomy.native-source-context')

const DEFAULT_SANDBOX_POLICY = Object.freeze({
  filesystem: Object.freeze({ access: 'none' }),
  network: Object.freeze({ access: 'none' }),
  schemaVersion: 1
})

const freezeJson = value => {
  if (value == null || typeof value !== 'object') return value
  for (const child of Object.values(value)) freezeJson(child)
  return Object.freeze(value)
}

const within = (root, target) => target === root || target.startsWith(`${root}${path.sep}`)

// Native pins a canonical workspace root. Rebase only the caller's root prefix;
// never realpath a selected Guest leaf or turn a symlinked module into a grant.
const selectedPath = (input, requestedRoot, canonicalRoot) => {
  const absolute = path.resolve(requestedRoot, input)
  return within(requestedRoot, absolute)
    ? path.resolve(canonicalRoot, path.relative(requestedRoot, absolute))
    : absolute
}

const canonicalPrivatePath = selected => {
  let parent = path.dirname(selected)
  const suffix = [path.basename(selected)]
  while (true) {
    try {
      return path.resolve(realpathSync(parent), ...suffix)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw new Error('Native private input parent is unavailable')
      }
      const ancestor = path.dirname(parent)
      if (ancestor === parent) throw new Error('Native private input parent is unavailable')
      suffix.unshift(path.basename(parent))
      parent = ancestor
    }
  }
}

const canonicalHome = selected => {
  try {
    return realpathSync(selected)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('Native Service home is unavailable')
    return canonicalPrivatePath(selected)
  }
}

const guestUrl = (root, file) => {
  const relative = path.relative(root, path.resolve(file))
  if (
    relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) throw new Error('Native entry is outside the workspace')
  const pathname = pathToFileURL(`/${relative.split(path.sep).join('/')}`).pathname
  return `app://workspace${pathname}`
}

const selectedJson = async (reader, input, optionName, cwd) => {
  if (typeof input !== 'string' || input === '' || path.extname(input).toLowerCase() !== '.json') {
    throw new Error(`${optionName} must reference one JSON file`)
  }
  const file = path.resolve(cwd, input)
  await reader.capturePrivate(file)
  const selected = await reader.readPrivate(file, 'config')
  if (selected == null || selected.bytes.byteLength > MAX_JSON_BYTES) {
    throw new Error(`${optionName} file is unavailable`)
  }
  let value
  try {
    value = JSON.parse(JSON_UTF8.decode(selected.bytes))
  } catch {
    throw new Error(`${optionName} file is not valid UTF-8 JSON`)
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${optionName} file must contain one object`)
  }
  return freezeJson(value)
}

const captureOwnerInputs = async (reader, home, options, cwd) => {
  await reader.reservePrivateDirectory(home)
  const paths = serviceHomePaths(home)
  for (
    const file of [
      path.join(home, 'native-runtime.json'),
      path.join(home, 'native-observer-profiles.json'),
      paths.token,
      paths.endpoint,
      paths.processProfiles,
      paths.processBackends,
      ...(options.openapiTokenFile == null ? [] : [path.resolve(cwd, options.openapiTokenFile)])
    ]
  ) await reader.capturePrivate(file)
  // Local installed Host resources may live beneath the caller workspace.
  // Classify their full closure in this same ledger before Guest collection;
  // only the target Service registry later authorizes requested profile IDs.
  await readServiceNativeObserverProfilesV1(home, { binaryPath: options.binaryPath, reader })
}

const decodeClosureRead = read => {
  if (
    typeof read?.url !== 'string' || typeof read?.bytesBase64 !== 'string' ||
    !Number.isSafeInteger(read.byteLength) || read.byteLength < 0 || read.byteLength > MAX_FILE_BYTES ||
    read.bytesBase64.length !== Math.ceil(read.byteLength / 3) * 4 ||
    typeof read.sha256 !== 'string' || !SHA256.test(read.sha256) ||
    (read.metadataOnly !== undefined && read.metadataOnly !== true)
  ) {
    throw new Error('Native source closure is invalid')
  }
  let bytes
  try {
    bytes = Buffer.from(read.bytesBase64, 'base64')
  } catch {
    throw new Error('Native source closure is invalid')
  }
  if (
    bytes.byteLength !== read.byteLength || bytes.toString('base64') !== read.bytesBase64 ||
    createHash('sha256').update(bytes).digest('hex') !== read.sha256
  ) {
    throw new Error('Native source closure changed')
  }
  let source
  try {
    source = UTF8.decode(bytes)
  } catch {
    throw new Error('Native source closure is not strict UTF-8')
  }
  return Object.freeze({
    ...(read.metadataOnly === true ? { metadataOnly: true } : {}),
    sha256: read.sha256,
    source,
    url: read.url
  })
}

const closureAliasUrl = (value, rootUrl) => {
  if (typeof value !== 'string' || value.length > 4_096 || !value.startsWith(rootUrl)) {
    throw new Error('Native source closure alias is invalid')
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Native source closure alias is invalid')
  }
  if (url.href !== value || url.hash || !url.pathname.startsWith('/')) {
    throw new Error('Native source closure alias is invalid')
  }
  return value
}

const collectSourceRows = async (reader, rootUrl, entryUrls, wrapper) => {
  const wrapperBytes = wrapper == null ? undefined : Buffer.from(wrapper.source, 'utf8')
  const loader = new HolonomyModuleLoader({
    readModule: (url, context) =>
      url === wrapper?.url
        ? { bytes: wrapperBytes, sha256: createHash('sha256').update(wrapperBytes).digest('hex') }
        : reader.readGuestResource(url, context?.purpose),
    syntheticNodeModules: Object.freeze(Object.create(null))
  }, {
    allowJsonModules: true,
    limits: {
      maxModules: MAX_MODULES,
      maxSourceBytes: MAX_FILE_BYTES,
      maxTotalSourceBytesPerPlan: MAX_GRAPH_BYTES
    },
    resolutionProfile: 'production',
    rootUrl
  })
  const rows = new Map()
  const aliases = new Map()
  const pathDigests = new Map()
  let totalBytes = 0
  let aliasBytes = 0
  let closureEntryUrl
  for (const entryUrl of entryUrls) {
    const closure = await loader.createSourceClosure(entryUrl, {
      isExternalModule: specifier =>
        specifier.startsWith('node:') ||
        specifier.startsWith('holo:') || isBuiltin(specifier)
    })
    if (closure.kind !== 'source-closure' || closure.rootUrl !== rootUrl) {
      throw new Error('Native source closure is invalid')
    }
    if (closureEntryUrl === undefined) closureEntryUrl = closureAliasUrl(closure.entryUrl, rootUrl)
    for (const selected of closure.reads) {
      const row = decodeClosureRead(selected)
      if (!row.url.startsWith(rootUrl)) throw new Error('Native source closure escaped the workspace')
      const selectedUrl = new URL(row.url)
      const pathname = selectedUrl.pathname
      if (
        row.metadataOnly === true &&
        (!pathname.endsWith('/package.json') || /[?#]/u.test(row.url))
      ) throw new Error('Native metadata-only source must be a canonical package.json')
      const priorPath = pathDigests.get(pathname.toLocaleLowerCase('en-US'))
      if (
        priorPath != null &&
        (priorPath.pathname !== pathname || priorPath.sha256 !== row.sha256 ||
          priorPath.metadataOnly !== (row.metadataOnly === true))
      ) {
        throw new Error('Native source changed during preparation')
      }
      pathDigests.set(pathname.toLocaleLowerCase('en-US'), {
        pathname,
        sha256: row.sha256,
        metadataOnly: row.metadataOnly === true
      })
      const prior = rows.get(row.url)
      if (prior != null) {
        if (
          prior.sha256 !== row.sha256 ||
          (prior.metadataOnly === true) !== (row.metadataOnly === true)
        ) throw new Error('Native source changed during preparation')
        continue
      }
      rows.set(row.url, row)
      totalBytes += selected.byteLength
      if (rows.size > MAX_MODULES || totalBytes > MAX_GRAPH_BYTES) {
        throw new Error('Native source graph exceeds its limit')
      }
    }
    if (closure.aliases !== undefined && !Array.isArray(closure.aliases)) {
      throw new Error('Native source closure aliases are invalid')
    }
    for (const alias of closure.aliases ?? []) {
      if (
        alias == null || typeof alias !== 'object' || Array.isArray(alias) ||
        Object.keys(alias).length !== 2 || !Object.hasOwn(alias, 'url') ||
        !Object.hasOwn(alias, 'canonicalUrl')
      ) throw new Error('Native source closure alias is invalid')
      const url = closureAliasUrl(alias.url, rootUrl)
      const canonicalUrl = closureAliasUrl(alias.canonicalUrl, rootUrl)
      if (url === canonicalUrl) throw new Error('Native source closure alias is invalid')
      const previous = aliases.get(url)
      if (previous != null) {
        if (previous !== canonicalUrl) throw new Error('Native source closure alias changed')
        continue
      }
      aliases.set(url, canonicalUrl)
      aliasBytes += Buffer.byteLength(url) + Buffer.byteLength(canonicalUrl)
      if (aliases.size > MAX_ALIASES || aliasBytes > MAX_ALIAS_BYTES) {
        throw new Error('Native source closure aliases exceed their limit')
      }
    }
  }
  for (const [url, canonicalUrl] of aliases) {
    if (rows.has(url) || !rows.has(canonicalUrl) || aliases.has(canonicalUrl)) {
      throw new Error('Native source closure alias target is invalid')
    }
  }
  const entryUrl = aliases.get(closureEntryUrl) ?? closureEntryUrl
  if (!rows.has(entryUrl) || rows.get(entryUrl).metadataOnly === true) {
    throw new Error('Native source closure entry is not a canonical module read')
  }
  return Object.freeze({
    entryUrl,
    modules: Object.freeze(
      [...rows.values()].sort((left, right) => left.url.localeCompare(right.url))
        .map(({ metadataOnly, source, url }) =>
          Object.freeze({
            ...(metadataOnly === true ? { metadataOnly: true } : {}),
            source,
            url
          })
        )
    ),
    moduleAliases: Object.freeze(
      [...aliases].sort(([left], [right]) => left.localeCompare(right))
        .map(([url, canonicalUrl]) => Object.freeze({ url, canonicalUrl }))
    )
  })
}

export const getHolonomyNativeSourceContext = snapshot => snapshot?.[NATIVE_CONTEXT]

export const prepareHolonomyNativeLaunchSnapshot = async (command, options, dependencies = {}) => {
  if (!['app+local://workspace/', 'app://workspace/'].includes(options.rootUrl)) {
    throw new Error('Native source graph requires app://workspace/ as its logical root')
  }
  const requestedCwd = path.resolve(dependencies.cwd ?? process.cwd())
  const cwd = realpathSync(requestedCwd)
  const entries = expandHolonomyEntries(options.entries, { native: true })
  if (command === 'run' && entries.length !== 1) {
    throw new Error('holonomy run requires exactly one entry module')
  }
  const selectedEntries = entries.map(entry => selectedPath(entry, requestedCwd, cwd))
  const entryUrls = selectedEntries.map(entry => guestUrl(cwd, entry))
  const home = canonicalHome(selectedPath(dependencies.home ?? resolveHolonomyHome(), requestedCwd, cwd))
  // The owner-only installation record locates the helper before it exists as
  // a reader. Label that selected executable immediately after initialization.
  const binaryPath = dependencies.nativeSourceExecutablePath == null
    ? await readServiceNativeRuntimeInstallation(home)
    : await validateNativeExecutable(dependencies.nativeSourceExecutablePath)
  if (binaryPath == null) throw new Error('Native source reader installation is unavailable')
  const reader = await (dependencies.createNativeSourceReader ?? createNativeSourceReader)({
    binaryPath,
    workspaceRoot: cwd,
    signal: dependencies.signal
  })
  try {
    if ((await reader.capturePrivate(binaryPath))?.kind !== 'file') {
      throw new Error('Native source reader executable is unavailable')
    }
    await captureOwnerInputs(reader, home, {
      binaryPath,
      openapiTokenFile: options.openapiTokenFile == null
        ? undefined
        : canonicalPrivatePath(selectedPath(options.openapiTokenFile, requestedCwd, cwd))
    }, cwd)
    const networkRuleSet = options.networkRules == null
      ? undefined
      : await selectedJson(
        reader,
        canonicalPrivatePath(selectedPath(options.networkRules, requestedCwd, cwd)),
        '--network-rules',
        cwd
      )
    const sandboxPolicy = options.sandbox == null
      ? DEFAULT_SANDBOX_POLICY
      : await selectedJson(
        reader,
        canonicalPrivatePath(selectedPath(options.sandbox, requestedCwd, cwd)),
        '--sandbox',
        cwd
      )
    const capabilityRuntime = options.capabilityRuntime == null
      ? undefined
      : await selectedJson(
        reader,
        canonicalPrivatePath(selectedPath(options.capabilityRuntime, requestedCwd, cwd)),
        '--capability-runtime',
        cwd
      )
    const preparedPlugins = options.config == null
      ? undefined
      : await prepareHolonomyRuntimePluginsNative(
        canonicalPrivatePath(selectedPath(options.config, requestedCwd, cwd)),
        {
          allowedAbsoluteRoots: options.pluginRoots.map(root => selectedPath(root, requestedCwd, cwd)),
          cwd,
          reader
        }
      )
    const uuid = dependencies.randomUUID?.() ?? randomUUID()
    const wrapper = command === 'test'
      ? Object.freeze({
        source: `${entryUrls.map(url => `import ${JSON.stringify(url)}`).join('\n')}\n`,
        url: new URL(`test-${uuid}.mjs`, 'app://workspace/').toString()
      })
      : undefined
    await reader.seal()
    const rootUrl = 'app://workspace/'
    const { entryUrl, modules, moduleAliases } = await collectSourceRows(
      reader,
      rootUrl,
      wrapper == null ? entryUrls : [wrapper.url],
      wrapper
    )
    const launch = Object.freeze({
      argv: Object.freeze([entryUrl, ...options.argv]),
      command,
      entryUrl,
      env: Object.freeze({ ...options.env }),
      moduleRootUrl: rootUrl,
      modules,
      ...(moduleAliases.length === 0 ? {} : { moduleAliases }),
      reporter: options.reporter,
      schemaVersion: 2,
      target: 'native'
    })
    const snapshot = {
      capabilityRuntime,
      entryUrl,
      fixture: requiresHolonomyNetworkFixture(command, selectedEntries)
        ? Object.freeze({ kind: 'conformance-network-v1' })
        : undefined,
      inspectorMode: options.inspect == null
        ? 'off'
        : options.inspect.breakBeforeEntry
        ? 'break'
        : 'enabled',
      isolation: options.isolation,
      launch,
      networkRuleSet,
      pluginConfigPath: preparedPlugins?.configPath,
      runtimePlugins: preparedPlugins?.bundles,
      sandboxPolicy,
      target: 'native'
    }
    Object.defineProperty(snapshot, NATIVE_CONTEXT, {
      value: Object.freeze({
        preparePlugins: (input, pluginOptions = {}) =>
          prepareHolonomyRuntimePluginsNative(canonicalPrivatePath(selectedPath(input, requestedCwd, cwd)), {
            ...pluginOptions,
            allowedAbsoluteRoots: (pluginOptions.allowedAbsoluteRoots ?? [])
              .map(root => selectedPath(root, requestedCwd, cwd)),
            cwd,
            reader
          }),
        reader
      })
    })
    return Object.freeze(snapshot)
  } catch (error) {
    await reader.close()
    throw error
  }
}
