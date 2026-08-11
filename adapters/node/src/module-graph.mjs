import vm from 'node:vm'

import { createContextValue } from './runtime-context.mjs'

const resolveSpecifier = (specifier, parentUrl) => {
  if (specifier.startsWith('node:')) return specifier
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(specifier)) {
    try {
      const url = new URL(specifier)
      if (url.href !== specifier || url.hash !== '') throw new TypeError('Non-canonical URL')
      return url.href
    } catch {
      throw new TypeError('Invalid Node Runtime module specifier')
    }
  }
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    throw new TypeError('Bare module specifiers are unavailable in Node Runtime')
  }
  try {
    return new URL(specifier, parentUrl).href
  } catch {
    throw new TypeError('Invalid Node Runtime module specifier')
  }
}

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
  }

  async evaluateEntry() {
    const entry = this.#getModule(this.#entryUrl)
    await entry.link((specifier, importer) => this.#link(specifier, importer))
    await entry.evaluate()
    return entry.namespace
  }

  installSyntheticModules(registry) {
    if (registry == null || typeof registry !== 'object' || Array.isArray(registry)) {
      throw new TypeError('Invalid live synthetic registry')
    }
    for (const specifier of Object.keys(registry)) {
      const binding = registry[specifier]
      const names = binding?.descriptor?.exportNames
      const namespace = binding?.namespace
      const invalidReason = !specifier.startsWith('node:')
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
    if (url.startsWith('node:')) return this.#getSyntheticModule(url)
    const definition = this.#definitions.get(url)
    if (definition == null) throw new TypeError(`Node Runtime module is outside the session graph: ${url}`)
    const module = new vm.SourceTextModule(definition.source, {
      context: this.#context,
      identifier: definition.url,
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
    const targetUrl = specifier === 'acorn' && importerDefinition?.kind === 'runtime'
      ? 'holonomy:///runtime/vendor/acorn.mjs'
      : resolveSpecifier(specifier, importer.identifier)
    if (importerDefinition?.kind === 'user' && targetUrl.startsWith('holonomy:')) {
      throw new TypeError('User modules cannot import Node Runtime internals')
    }
    return this.#getModule(targetUrl)
  }
}
