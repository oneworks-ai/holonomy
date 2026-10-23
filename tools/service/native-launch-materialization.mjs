/* eslint-disable max-lines -- One Native graph admission validates modules, aliases, and staging together. */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { serviceError } from './errors.mjs'
import { normalizeNativeDiagnosticAuditInstallation } from './native-diagnostic-audit-installation.mjs'
import { normalizeNativeDiagnosticSourceReaderInstallation } from './native-diagnostic-source-reader-installation.mjs'
import {
  materializeNativeObserverProfilesV1,
  validateNativeObserverProfilesForLaunchV1
} from './native-observer-materialization.mjs'
import {
  MAX_NATIVE_PLUGIN_GENERATION_BYTES,
  materializeNativePluginGraph,
  replaceNativePluginConfig
} from './native-plugin-materialization.mjs'
import { requireIdentifier, requireInteger } from './validation.mjs'

const ROOT_URL = 'app://workspace/'
const MAX_MODULES = 512
const MAX_ALIASES = 512
const MAX_ALIAS_BYTES = 256 * 1024
const MAX_MODULE_BYTES = 8 * 1024 * 1024
const MAX_GRAPH_BYTES = 32 * 1024 * 1024
const MAX_PROCESS_PROFILE_MANIFEST_BYTES = 1024 * 1024

const invalid = () => {
  throw serviceError('service.invalid_request', 'Native source graph is invalid')
}

export const nativeModuleSegments = value => {
  if (typeof value !== 'string' || !value.startsWith(ROOT_URL) || value.length > 4_096) invalid()
  let url
  try {
    url = new URL(value)
  } catch {
    invalid()
  }
  if (
    url.href !== value || url.protocol !== 'app:' || url.hostname !== 'workspace' ||
    url.username !== '' || url.password !== '' || url.port !== '' ||
    url.hash !== ''
  ) invalid()
  const segments = url.pathname.slice(1).split('/').map(segment => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return invalid()
    }
  })
  if (
    segments.some(segment =>
      segment === '' || segment === '.' || segment === '..' || segment.includes('/') ||
      segment.includes('\\') || segment.includes('\0') || segment !== segment.normalize('NFC')
    )
  ) invalid()
  const canonical = new URL(ROOT_URL)
  canonical.pathname = `/${segments.map(segment => segment.replaceAll('%', '%25')).join('/')}`
  if (canonical.pathname !== url.pathname) invalid()
  return segments
}

export const validateNativeLaunchGraph = launch => {
  if (
    launch?.schemaVersion !== 2 || launch.target !== 'native' ||
    launch.moduleRootUrl !== ROOT_URL || !Array.isArray(launch.modules) ||
    launch.modules.length < 1 || launch.modules.length > MAX_MODULES ||
    !Array.isArray(launch.argv) || launch.argv[0] !== launch.entryUrl
  ) invalid()
  const entry = nativeModuleSegments(launch.entryUrl)
  if (/[?#]/u.test(launch.entryUrl)) invalid()
  if (launch.argv.length > 257) invalid()
  let argvBytes = 0
  for (const argument of launch.argv.slice(1)) {
    if (typeof argument !== 'string' || argument.includes('\0')) invalid()
    const bytes = Buffer.byteLength(argument, 'utf8')
    argvBytes += bytes
    if (bytes > 65_536 || argvBytes > 256 * 1024) invalid()
  }
  const seen = new Set()
  const modulesByUrl = new Map()
  const physical = new Map()
  const metadataOnlyUrls = []
  let total = 0
  const digest = createHash('sha256')
  for (const module of launch.modules) {
    if (
      module == null || typeof module !== 'object' || Array.isArray(module) ||
      typeof module.source !== 'string' ||
      Object.keys(module).some(key => !['metadataOnly', 'source', 'url'].includes(key)) ||
      (Object.hasOwn(module, 'metadataOnly') && module.metadataOnly !== true)
    ) invalid()
    const segments = nativeModuleSegments(module.url)
    if (
      module.metadataOnly === true &&
      (segments.at(-1) !== 'package.json' || /[?#]/u.test(module.url))
    ) invalid()
    if (seen.has(module.url)) invalid()
    seen.add(module.url)
    modulesByUrl.set(module.url, module)
    const pathname = segments.join('/')
    const key = pathname.toLocaleLowerCase('en-US')
    const prior = physical.get(key)
    if (
      prior != null &&
      (prior.pathname !== pathname || prior.source !== module.source ||
        prior.metadataOnly !== (module.metadataOnly === true))
    ) invalid()
    if (prior == null) {
      physical.set(
        key,
        Object.freeze({
          metadataOnly: module.metadataOnly === true,
          pathname,
          segments: Object.freeze(segments),
          source: module.source
        })
      )
    }
    if (module.metadataOnly === true) metadataOnlyUrls.push(module.url)
    const bytes = Buffer.byteLength(module.source, 'utf8')
    total += bytes
    if (bytes > MAX_MODULE_BYTES || total > MAX_GRAPH_BYTES) invalid()
    digest.update(module.url).update('\0').update(String(bytes)).update('\0').update(module.source).update('\0')
  }
  const entryModule = modulesByUrl.get(launch.entryUrl)
  if (entryModule == null || entryModule.metadataOnly === true) invalid()
  const inputAliases = Object.hasOwn(launch, 'moduleAliases') ? launch.moduleAliases : []
  if (!Array.isArray(inputAliases) || inputAliases.length > MAX_ALIASES) invalid()
  const aliases = []
  const seenAliases = new Set()
  const aliasPhysical = new Map(physical)
  let aliasBytes = 0
  const identitySuffix = url => url.slice(ROOT_URL.length - 1 + new URL(url).pathname.length)
  for (const alias of inputAliases) {
    if (
      alias == null || typeof alias !== 'object' || Array.isArray(alias) ||
      Object.keys(alias).length !== 2 || !Object.hasOwn(alias, 'url') ||
      !Object.hasOwn(alias, 'canonicalUrl')
    ) invalid()
    const segments = nativeModuleSegments(alias.url)
    nativeModuleSegments(alias.canonicalUrl)
    const target = modulesByUrl.get(alias.canonicalUrl)
    if (
      alias.url === alias.canonicalUrl || seen.has(alias.url) ||
      seenAliases.has(alias.url) || target == null ||
      identitySuffix(alias.url) !== identitySuffix(alias.canonicalUrl)
    ) invalid()
    if (
      target.metadataOnly === true &&
      (segments.at(-1) !== 'package.json' || /[?#]/u.test(alias.url))
    ) invalid()
    seenAliases.add(alias.url)
    aliasBytes += Buffer.byteLength(alias.url) + Buffer.byteLength(alias.canonicalUrl)
    if (aliasBytes > MAX_ALIAS_BYTES) invalid()
    const pathname = segments.join('/')
    const key = pathname.toLocaleLowerCase('en-US')
    const prior = aliasPhysical.get(key)
    if (
      prior != null &&
      (prior.pathname !== pathname || prior.source !== target.source ||
        prior.metadataOnly !== (target.metadataOnly === true))
    ) invalid()
    if (prior == null) {
      aliasPhysical.set(key, {
        metadataOnly: target.metadataOnly === true,
        pathname,
        source: target.source
      })
    }
    aliases.push(Object.freeze({ url: alias.url, canonicalUrl: alias.canonicalUrl }))
  }
  aliases.sort((left, right) => left.url.localeCompare(right.url))
  for (const alias of aliases) {
    digest.update('alias\0').update(alias.url).update('\0').update(alias.canonicalUrl).update('\0')
  }
  // Canonical URLs are ASCII; use code-unit order, never host locale collation.
  metadataOnlyUrls.sort()
  if (metadataOnlyUrls.length > 0) {
    digest.update('metadata-only-v1\0')
    for (const url of metadataOnlyUrls) digest.update(url).update('\0')
  }
  return Object.freeze({
    digest: digest.digest('hex'),
    entrySegments: Object.freeze(entry),
    moduleCount: seen.size,
    entryUrl: launch.entryUrl,
    moduleAliases: Object.freeze(aliases),
    moduleAllowlist: Object.freeze([...seen, ...aliases.map(alias => alias.url)]),
    moduleMetadataOnly: Object.freeze(metadataOnlyUrls),
    physicalModules: Object.freeze([...physical.values()])
  })
}

export const materializeNativeLaunch = async (
  process,
  stateDirectory,
  capabilityRuntime,
  preflight = () => {},
  deviceProvider
) => {
  const graph = validateNativeLaunchGraph(process.launch)
  const processId = requireIdentifier(process.id, 'Native process id')
  const generation = requireInteger(process.generation, 'Native generation', { min: 1 })
  const processRoot = join(stateDirectory, 'native-processes', processId)
  const generationRoot = join(processRoot, `g${generation}`)
  const guestRoot = join(generationRoot, 'guest')
  const hostRoot = join(generationRoot, 'host')
  if (
    process.capabilityRuntime != null && capabilityRuntime?.policyDigest !== process.capabilityRuntime.policyDigest
  ) {
    throw serviceError('service.precondition_failed', 'Native Capability Runtime binding is unavailable')
  }
  const processProfileId = process.capabilityRuntime?.processProfileId
  const processProfile = capabilityRuntime?.processProfile
  if (
    processProfileId !== capabilityRuntime?.processProfileId ||
    (processProfileId == null) !== (processProfile == null) ||
    (processProfileId != null && capabilityRuntime?.policy?.process?.access !== 'sandboxed')
  ) {
    throw serviceError('service.precondition_failed', 'Native Process profile binding is unavailable')
  }
  const policy = capabilityRuntime?.policy ?? { schemaVersion: 2 }
  const observerProfiles = validateNativeObserverProfilesForLaunchV1(process, capabilityRuntime)
  let diagnosticSourceReader
  try {
    diagnosticSourceReader = normalizeNativeDiagnosticSourceReaderInstallation(
      capabilityRuntime?.diagnosticSourceReader
    )
  } catch {
    throw serviceError('service.precondition_failed', 'Native diagnostic source reader binding is invalid')
  }
  let diagnosticAudit
  try {
    diagnosticAudit = normalizeNativeDiagnosticAuditInstallation(capabilityRuntime?.diagnosticAudit)
  } catch {
    throw serviceError('service.precondition_failed', 'Native diagnostic audit binding is invalid')
  }
  if (
    (policy.diagnostics?.sourceReader === 'boundedSource') !== (diagnosticSourceReader != null) ||
    diagnosticSourceReader != null && policy.diagnostics.maxSourceReadBytes < 1
  ) {
    throw serviceError('service.precondition_failed', 'Native diagnostic source reader binding is unavailable')
  }
  if (diagnosticAudit != null && diagnosticSourceReader == null) {
    throw serviceError('service.precondition_failed', 'Native diagnostic audit binding is unavailable')
  }
  const filesystemRoots = policy.filesystem?.access === 'sandboxed'
    ? [{ hostPath: join(processRoot, 'workspace'), rootId: 'workspace' }]
    : []
  const hostConfig = {
    context: capabilityRuntime?.context ?? { schemaVersion: 1 },
    ...(deviceProvider == null ? {} : { deviceProvider }),
    ...(diagnosticSourceReader == null ? {} : { diagnosticSourceReader }),
    ...(diagnosticAudit == null
      ? {}
      : { diagnosticAudit: Object.freeze({ path: './audit/source-reads.jsonl', maxBytes: diagnosticAudit.maxBytes }) }),
    filesystemRoots,
    ...(processProfileId == null ? {} : { processProfileId }),
    sandboxPolicy: policy,
    schemaVersion: 1,
    systemProjection: capabilityRuntime == null
      ? { fields: {}, schemaVersion: 1 }
      : capabilityRuntime.systemProjection
  }
  const hostConfigPath = join(hostRoot, 'host.json')
  const processProfilesManifest = processProfileId == null
    ? undefined
    : join(hostRoot, 'process-profiles.json')
  const processProfilesManifestText = processProfilesManifest == null
    ? undefined
    : JSON.stringify({ profiles: { [processProfileId]: processProfile }, schemaVersion: 1 })
  if (
    processProfilesManifestText != null &&
    Buffer.byteLength(processProfilesManifestText, 'utf8') > MAX_PROCESS_PROFILE_MANIFEST_BYTES
  ) {
    throw serviceError('service.limit_exceeded', 'Native Process profile manifest exceeds the Host limit')
  }
  const prepared = Object.freeze({
    entryPath: join(guestRoot, ...graph.entrySegments),
    workspaceRoot: guestRoot,
    generationRoot,
    hostConfig: Object.freeze(hostConfig),
    hostConfigPath,
    hostRoot,
    processProfilesManifest,
    moduleAliases: graph.moduleAliases,
    moduleAllowlist: graph.moduleAllowlist,
    moduleMetadataOnly: graph.moduleMetadataOnly,
    sourceGraphDigest: graph.digest
  })
  preflight(prepared)
  await mkdir(processRoot, { recursive: true, mode: 0o700 })
  await mkdir(generationRoot, { mode: 0o700 })
  try {
    await mkdir(guestRoot, { mode: 0o700 })
    await mkdir(hostRoot, { mode: 0o700 })
    if (diagnosticAudit != null) await mkdir(join(hostRoot, 'audit'), { mode: 0o700 })
    if (processProfilesManifest != null) {
      await writeFile(
        processProfilesManifest,
        processProfilesManifestText,
        { flag: 'wx', mode: 0o600 }
      )
    }
    if (filesystemRoots.length > 0) await mkdir(filesystemRoots[0].hostPath, { recursive: true, mode: 0o700 })
    for (const module of graph.physicalModules) {
      const segments = module.segments
      const file = join(guestRoot, ...segments)
      await mkdir(join(guestRoot, ...segments.slice(0, -1)), { recursive: true, mode: 0o700 })
      await writeFile(file, module.source, { flag: 'wx', mode: 0o400 })
    }
    const pluginGraph = await materializeNativePluginGraph(
      hostRoot,
      process.pluginGraphRevision ?? 0,
      process.runtimePlugins ?? []
    )
    const observers = await materializeNativeObserverProfilesV1(
      hostRoot,
      observerProfiles,
      MAX_NATIVE_PLUGIN_GENERATION_BYTES - pluginGraph.bytes
    )
    const finalHostConfig = Object.freeze({
      ...hostConfig,
      ...(observers.observerProfiles.length === 0
        ? {}
        : { observerProfiles: observers.observerProfiles })
    })
    await replaceNativePluginConfig(hostRoot, { ...finalHostConfig, plugins: pluginGraph.plugins })
    await writeFile(
      join(hostRoot, 'graph.json'),
      JSON.stringify({
        digest: graph.digest,
        entryUrl: graph.entryUrl,
        moduleCount: graph.moduleCount,
        moduleRootUrl: ROOT_URL
      }),
      { flag: 'wx', mode: 0o600 }
    )
    return Object.freeze({
      ...prepared,
      hostConfig: finalHostConfig,
      pluginDiskBytes: pluginGraph.bytes + observers.bytes,
      plugins: pluginGraph.plugins
    })
  } catch (error) {
    await rm(generationRoot, { force: true, recursive: true }).catch(() => undefined)
    throw error
  }
}
