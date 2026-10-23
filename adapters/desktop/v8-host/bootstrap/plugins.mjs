/* eslint-disable max-lines -- Initial Host preflight and watch replacement share one immutable graph owner. */
import {
  HolonomyRuntimePluginAppV1,
  normalizeRuntimePluginBundlesV1,
  normalizeRuntimePluginBundlesV2,
  runtimePluginBundleDigestV1,
  runtimePluginBundleDigestV2
} from '../../../../packages/runtime/src/app/index.ts'
import { CapabilityInvocationError } from '../../../../packages/runtime/src/kernel/index.ts'
import { HolonomyModuleLoader } from '../../../../packages/runtime/src/module-loader/index.ts'
import { analyzeModuleSource } from '../../../../packages/runtime/src/module-loader/source-analysis.ts'
import { decodeBase64 } from '../../../../packages/runtime/src/node-compat/encoding.ts'

export const createNativePluginHost = (native, engineGates, observers) => {
  let kernel
  let pluginApp
  const pluginScopes = new Map()
  const gateScopes = new Map()
  let activeEntries = new Set()
  let preparedInitial

  const pluginKey = definition =>
    JSON.stringify([
      definition.instanceId,
      definition.bundleSha256,
      definition.entryUrl,
      definition.exportName,
      definition.config
    ])
  const pluginDefinitions = bundles =>
    bundles.map(bundle => ({
      bundleSha256: bundle.bundleSha256,
      config: bundle.config,
      entryUrl: bundle.entryUrl,
      exportName: bundle.exportName,
      instanceId: bundle.instanceId
    }))
  const readPluginModule = (url, context) => {
    const source = native.pluginSource(url, context.purpose)
    if (source === null) return null
    const parsed = JSON.parse(source)
    return Object.freeze({
      bytes: new Uint8Array(parsed.bytes),
      sha256: parsed.sha256,
      ...(Object.hasOwn(parsed, 'metadataOnly') ? { metadataOnly: parsed.metadataOnly } : {})
    })
  }
  const readPluginModuleResource = (url, context) => {
    const source = native.pluginSourceResource(url, context.purpose)
    if (source === null) return null
    const parsed = JSON.parse(source)
    return Object.freeze({
      bytes: new Uint8Array(parsed.bytes),
      sha256: parsed.sha256,
      canonicalUrl: parsed.canonicalUrl,
      ...(Object.hasOwn(parsed, 'metadataOnly') ? { metadataOnly: parsed.metadataOnly } : {})
    })
  }
  const bareSpecifier = value =>
    typeof value === 'string' && !value.startsWith('#') && !value.startsWith('.') &&
    !value.startsWith('/') && !/^[A-Za-z][A-Za-z\d+.-]*:/u.test(value)
  const preparePluginBundle = async installation => {
    let plan
    let requiresGraph = installation.resourceGraph?.required === true
    if (!requiresGraph) {
      const loader = new HolonomyModuleLoader(
        Object.freeze({ readModule: readPluginModule, syntheticNodeModules: Object.freeze({}) }),
        Object.freeze({ rootUrl: installation.rootUrl, captureDynamicImports: true })
      )
      if (installation.resourceGraph?.schemaVersion === 2) {
        try {
          const probe = await loader.createSourceClosure(installation.entryUrl, {
            isExternalModule: bareSpecifier
          })
          requiresGraph = probe.externalReferences.length > 0 || probe.reads.some(read => {
            if (!/\.m?js$/u.test(new URL(read.url).pathname)) return false
            const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
              .decode(decodeBase64(read.bytesBase64))
            return analyzeModuleSource(source, 'module', read.url).dependencies.some(dependency =>
              dependency.specifier?.startsWith('#')
            )
          })
        } catch (error) {
          if (
            error?.code === 'ERR_HOLONOMY_MODULE_PATH_ESCAPE' ||
            error?.code === 'ERR_PACKAGE_IMPORT_NOT_DEFINED' && error?.specifier?.startsWith('#')
          ) requiresGraph = true
          else throw error
        }
      }
      if (!requiresGraph) plan = await loader.createPlan(installation.entryUrl)
    }
    if (requiresGraph) {
      if (installation.resourceGraph?.schemaVersion !== 2) {
        throw new Error('Native plugin source resource graph is unavailable')
      }
      const rootUrl = installation.resourceGraph.rootUrl
      const entryUrl = installation.resourceGraph.entryUrl
      const sourceLoader = new HolonomyModuleLoader(
        Object.freeze({ readModule: readPluginModuleResource, syntheticNodeModules: Object.freeze({}) }),
        Object.freeze({ rootUrl, captureDynamicImports: true })
      )
      const sourceClosure = await sourceLoader.createSourceClosure(entryUrl, {
        isExternalModule: () => false
      })
      const raw = Object.freeze({
        config: installation.config,
        ...(installation.configSchema == null ? {} : { configSchema: installation.configSchema }),
        entryUrl,
        exportName: installation.exportName,
        instanceId: installation.instanceId,
        rootUrl,
        schemaVersion: 2,
        sourceClosure
      })
      const bundleSha256 = runtimePluginBundleDigestV2(raw)
      if (installation.integrity != null && installation.integrity !== bundleSha256) {
        throw new Error(`Native plugin integrity mismatch: ${installation.instanceId}`)
      }
      const [bundle] = normalizeRuntimePluginBundlesV2([{ ...raw, bundleSha256 }])
      const reads = new Map(bundle.sourceClosure.reads.map(read => [read.url, read]))
      const aliases = new Map(bundle.sourceClosure.aliases.map(alias => [alias.url, alias.canonicalUrl]))
      const loader = new HolonomyModuleLoader(
        Object.freeze({
          readModule: url => {
            const canonicalUrl = aliases.get(url) ?? url
            const read = reads.get(canonicalUrl)
            return read == null ? null : Object.freeze({
              bytes: decodeBase64(read.bytesBase64),
              sha256: read.sha256,
              canonicalUrl
            })
          },
          syntheticNodeModules: Object.freeze({})
        }),
        Object.freeze({ rootUrl, captureDynamicImports: true })
      )
      const plan = await loader.createPlan(bundle.entryUrl)
      if (plan.modules.some(module => module.format !== 'module' || module.source === null || module.sha256 === null)) {
        throw new Error(`Native plugin module graph is unsupported: ${installation.instanceId}`)
      }
      const entry = native.pluginPlan(JSON.stringify(plan), bundleSha256)
      if (entry !== `${bundle.entryUrl}?holo-bundle=${bundle.bundleSha256}`) {
        throw new Error('Native plugin graph identity mismatch')
      }
      return Object.freeze({ bundle, entry })
    }
    if (plan == null) throw new Error('Native plugin source plan is unavailable')
    if (plan.modules.some(module => module.format !== 'module' || module.source === null || module.sha256 === null)) {
      throw new Error(`Native plugin module graph is unsupported: ${installation.instanceId}`)
    }
    const raw = Object.freeze({
      config: installation.config,
      ...(installation.configSchema == null ? {} : { configSchema: installation.configSchema }),
      entryUrl: installation.entryUrl,
      exportName: installation.exportName,
      files: Object.freeze(plan.modules.map(module =>
        Object.freeze({
          sha256: module.sha256,
          source: module.source,
          url: module.url
        })
      )),
      instanceId: installation.instanceId,
      rootUrl: installation.rootUrl,
      schemaVersion: 1
    })
    const bundleSha256 = runtimePluginBundleDigestV1(raw)
    if (installation.integrity != null && installation.integrity !== bundleSha256) {
      throw new Error(`Native plugin integrity mismatch: ${installation.instanceId}`)
    }
    const bundle = normalizeRuntimePluginBundlesV1([{ ...raw, bundleSha256 }])[0]
    const entry = native.pluginPlan(JSON.stringify(plan), bundleSha256)
    if (entry !== `${bundle.entryUrl}?holo-bundle=${bundle.bundleSha256}`) {
      throw new Error('Native plugin graph identity mismatch')
    }
    return Object.freeze({ bundle, entry })
  }
  const replace = async installations => {
    if (preparedInitial != null && preparedInitial.identity !== JSON.stringify(installations)) {
      throw new Error('Native Host plugin installation changed after preflight')
    }
    const prepared = preparedInitial?.entries ?? []
    preparedInitial = undefined
    const preparedEntries = new Set(prepared.map(item => item.entry))
    try {
      if (prepared.length === 0) {
        for (const installation of installations) {
          const item = await preparePluginBundle(installation)
          prepared.push(item)
          preparedEntries.add(item.entry)
        }
      }
      const bundles = prepared.map(item => item.bundle)
      const snapshot = await pluginApp.replace(pluginDefinitions(bundles))
      for (const entry of activeEntries) if (!preparedEntries.has(entry)) native.pluginGraphRelease(entry)
      activeEntries = preparedEntries
      return snapshot
    } finally {
      for (const entry of preparedEntries) if (!activeEntries.has(entry)) native.pluginGraphRelease(entry)
    }
  }
  const initialize = async (runtimeKernel, installations) => {
    kernel = runtimeKernel
    pluginApp = new HolonomyRuntimePluginAppV1({
      createContextService: (definition, lifecycle) => {
        const key = pluginKey(definition)
        const scope = kernel.createPluginInterceptorScope(definition.instanceId)
        const gateScope = engineGates.createPluginScope(definition.instanceId)
        pluginScopes.set(key, scope)
        gateScopes.set(key, gateScope)
        lifecycle.registerDispose(() => {
          if (pluginScopes.get(key) === scope) pluginScopes.delete(key)
          scope.dispose()
          if (gateScopes.get(key) === gateScope) gateScopes.delete(key)
          gateScope.dispose()
        })
        return Object.freeze({
          deny: invocation => {
            throw new CapabilityInvocationError(
              'middleware.permission_denied',
              invocation.operation,
              invocation.resource.requested.semanticResourceDigest
            )
          },
          intercept: (matcher, middleware, options) => scope.use(matcher, middleware, options),
          engineGate: middleware => gateScope.use(middleware),
          observe: (registration, callback) => {
            const subscription = observers.observe(registration, callback)
            lifecycle.registerDispose(() => subscription.dispose())
            return subscription
          }
        })
      },
      drain: revision => Promise.all([kernel.drainPluginGraph(revision), engineGates.drainPluginGraph(revision)]),
      importModule: async entryUrl => {
        const marker = entryUrl.indexOf('?holo-bundle=')
        if (marker < 0) throw new Error('Native plugin entry is missing its immutable bundle marker')
        return await import(entryUrl)
      },
      publish: (revision, next) => {
        const scopes = next.map(definition => pluginScopes.get(pluginKey(definition)))
        if (scopes.some(scope => scope == null)) throw new Error('Native plugin interceptor scope is unavailable')
        const publishGates = engineGates.preparePluginGraph(
          revision,
          next.map(definition => gateScopes.get(pluginKey(definition)))
        )
        // Both registries validate before mutation. No plugin callback/await runs
        // between these commits; the plugin app owns their one graph revision.
        kernel.publishPluginGraph(revision, scopes)
        publishGates()
      }
    })
    return await replace(installations)
  }
  return {
    initialize,
    replace,
    async prepareHostPlugins(installations) {
      if (preparedInitial != null) throw new Error('Native Host plugins are already prepared')
      const prepared = []
      try {
        for (const installation of installations) prepared.push(await preparePluginBundle(installation))
        preparedInitial = Object.freeze({
          entries: prepared,
          identity: JSON.stringify(installations)
        })
      } catch (error) {
        for (const item of prepared) native.pluginGraphRelease(item.entry)
        throw error
      }
    },
    async close() {
      await pluginApp?.close()
      pluginApp = undefined
      pluginScopes.clear()
      gateScopes.clear()
      for (const entry of activeEntries) native.pluginGraphRelease(entry)
      activeEntries.clear()
      for (const item of preparedInitial?.entries ?? []) native.pluginGraphRelease(item.entry)
      preparedInitial = undefined
    }
  }
}
