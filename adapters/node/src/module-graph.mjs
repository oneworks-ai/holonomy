import vm from 'node:vm'

import { pluginIdentity, resolveRuntimeModuleSpecifier } from './module-graph-specifier.mjs'
import { createContextValue } from './runtime-context.mjs'
import { isTrustedRuntimePluginLibrary, resolveRuntimeWorkspaceSpecifier } from './runtime-workspace-specifier.mjs'

export class SessionModuleGraph {
  #context
  #definitions = new Map()
  #entryUrl
  #liveSynthetic = new Map()
  #modules = new Map()
  #runtimeContext
  #synthetic

  constructor(runtimeContext, session) {
    this.#runtimeContext = runtimeContext
    this.#context = runtimeContext.context
    this.#entryUrl = session.entryUrl
    this.#synthetic = session.syntheticModules
    for (const definition of [...session.runtimeModules, ...session.userModules]) {
      this.#definitions.set(definition.url, definition)
    }
    this.addRuntimePlugins(session.runtimePlugins)
  }

  addRuntimePlugins(bundles) {
    for (const bundle of bundles) {
      for (const file of bundle.files) {
        this.#definitions.set(
          pluginIdentity(file.url, bundle.bundleSha256),
          Object.freeze({
            bundleSha256: bundle.bundleSha256,
            instanceId: bundle.instanceId,
            kind: 'plugin',
            rootUrl: bundle.rootUrl,
            source: file.source,
            url: file.url
          })
        )
      }
    }
  }

  retainRuntimePlugins(bundles) {
    const retained = new Set(
      bundles.flatMap(bundle => bundle.files.map(file => pluginIdentity(file.url, bundle.bundleSha256)))
    )
    for (const [identity, definition] of this.#definitions) {
      if (definition.kind === 'plugin' && !retained.has(identity)) {
        this.#definitions.delete(identity)
        this.#modules.delete(identity)
      }
    }
  }

  async importModule(url) {
    const module = this.#getModule(url)
    if (module.status === 'unlinked') await module.link((specifier, importer) => this.#link(specifier, importer))
    if (module.status === 'linked') await module.evaluate()
    return module.namespace
  }

  async evaluateEntry() {
    return this.importModule(this.#entryUrl)
  }

  installSyntheticModules(registry) {
    if (registry == null || typeof registry !== 'object' || Array.isArray(registry)) {
      throw new TypeError('Invalid live synthetic registry')
    }
    for (const specifier of Object.keys(registry)) {
      const binding = registry[specifier]
      const names = binding?.descriptor?.exportNames
      const namespace = binding?.namespace
      const invalidReason = !/^(?:holo|node):[a-z\d][a-z\d_./-]*$/u.test(specifier)
        ? 'specifier'
        : !Array.isArray(names)
        ? 'names'
        : namespace == null || (typeof namespace !== 'object' && typeof namespace !== 'function')
        ? 'namespace'
        : names.some(name => typeof name !== 'string')
        ? 'name'
        : this.#modules.has(specifier) || this.#synthetic[specifier] != null
        ? 'collision'
        : undefined
      if (invalidReason != null) throw new TypeError(`Invalid live synthetic module: ${specifier}:${invalidReason}`)
      const values = Object.create(null)
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(namespace, name)
        if (descriptor == null || !('value' in descriptor)) throw new TypeError('Invalid live synthetic export')
        values[name] = descriptor.value
      }
      this.#liveSynthetic.set(specifier, Object.freeze({ names: Object.freeze([...new Set(names)]), values }))
    }
  }

  #getModule(url) {
    const existing = this.#modules.get(url)
    if (existing != null) return existing
    if (this.#liveSynthetic.has(url) || this.#synthetic[url] != null) return this.#getSyntheticModule(url)
    const definition = this.#definitions.get(url)
    if (definition == null) throw new TypeError(`Node Runtime module is outside the session graph: ${url}`)
    const module = new vm.SourceTextModule(definition.source, {
      context: this.#context,
      identifier: url,
      importModuleDynamically: async (specifier, importer) => {
        const target = this.#link(specifier, importer)
        if (target.status === 'unlinked') await target.link((nested, from) => this.#link(nested, from))
        if (target.status === 'linked') await target.evaluate()
        return target
      },
      initializeImportMeta(meta) {
        meta.url = definition.url
      }
    })
    this.#modules.set(url, module)
    return module
  }

  #getSyntheticModule(specifier) {
    const existing = this.#modules.get(specifier)
    if (existing != null) return existing
    const live = this.#liveSynthetic.get(specifier)
    const exports = this.#synthetic[specifier]
    if (live == null && exports == null) throw new TypeError('Node Runtime synthetic module is unavailable')
    const names = live?.names ?? Object.keys(exports)
    const values = live?.values ?? Object.fromEntries(
      names.map(name => [name, createContextValue(this.#runtimeContext, exports[name])])
    )
    const module = new vm.SyntheticModule(names, function evaluate() {
      for (const name of names) this.setExport(name, values[name])
    }, { context: this.#context, identifier: specifier })
    this.#modules.set(specifier, module)
    return module
  }

  #link(specifier, importer) {
    const importerDefinition = this.#definitions.get(importer.identifier)
    let targetUrl = this.#liveSynthetic.has(specifier) || this.#synthetic[specifier] != null
      ? specifier
      : specifier === 'acorn' && importerDefinition?.kind === 'runtime'
      ? 'holonomy:///runtime/vendor/acorn.mjs'
      : specifier === 'cordis' && ['plugin', 'runtime'].includes(importerDefinition?.kind)
      ? 'holonomy:///runtime/vendor/cordis.mjs'
      : specifier === 'cosmokit' && importer.identifier === 'holonomy:///runtime/vendor/cordis.mjs'
      ? 'holonomy:///runtime/vendor/cosmokit.mjs'
      : (importerDefinition?.kind === 'runtime' ||
          (importerDefinition?.kind === 'plugin' && isTrustedRuntimePluginLibrary(specifier))) &&
          resolveRuntimeWorkspaceSpecifier(specifier) != null
      ? resolveRuntimeWorkspaceSpecifier(specifier)
      : resolveRuntimeModuleSpecifier(specifier, importer.identifier)
    if (
      importerDefinition?.kind === 'plugin' && targetUrl.startsWith('holo-plugins:') &&
      !new URL(targetUrl).searchParams.has('holo-bundle')
    ) {
      const publicUrl = resolveRuntimeModuleSpecifier(specifier, importerDefinition.url)
      targetUrl = pluginIdentity(publicUrl, importerDefinition.bundleSha256)
    }
    if (importerDefinition?.kind === 'user' && targetUrl.startsWith('holonomy:')) {
      throw new TypeError('User modules cannot import Node Runtime internals')
    }
    if (importerDefinition?.kind === 'user' && targetUrl.startsWith('holo-plugins:')) {
      throw new TypeError('User modules cannot import Runtime plugin assets')
    }
    if (importerDefinition?.kind === 'plugin') {
      const publicTarget = new URL(targetUrl)
      publicTarget.search = ''
      if (targetUrl.startsWith('holo-plugins:') && !publicTarget.href.startsWith(importerDefinition.rootUrl)) {
        throw new TypeError('Runtime plugins cannot import another plugin instance')
      }
      const targetDefinition = this.#definitions.get(targetUrl)
      if (
        !targetUrl.startsWith('holo-plugins:') &&
        targetUrl !== 'holonomy:///runtime/vendor/cordis.mjs' &&
        targetUrl !== 'holonomy:///runtime/vendor/cosmokit.mjs' &&
        targetDefinition?.kind !== 'runtime'
      ) throw new TypeError('Runtime plugins cannot import Guest modules')
    }
    return this.#getModule(targetUrl)
  }
}
