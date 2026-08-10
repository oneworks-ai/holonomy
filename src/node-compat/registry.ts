import { createBufferSyntheticModule } from './buffer.js'
import type { BufferSyntheticModule } from './buffer.js'
import type { NodeCoreModuleSpecifier } from './capabilities.js'
import { createEventsSyntheticModule } from './events.js'
import type { EventsSyntheticModule } from './events.js'
import { resolveNodeCoreCompatOptions } from './options.js'
import { createOsSyntheticModule } from './os.js'
import type { OsSyntheticModule } from './os.js'
import { createPathSyntheticModule } from './path.js'
import type { PathSyntheticModule } from './path.js'
import { createProcessSyntheticModule } from './process.js'
import type { ProcessSyntheticModule } from './process.js'
import type { NodeCoreCompatOptions } from './types.js'
import { createUrlSyntheticModule } from './url.js'
import type { UrlSyntheticModule } from './url.js'

export type NodeCoreSyntheticModule =
  | BufferSyntheticModule
  | EventsSyntheticModule
  | OsSyntheticModule
  | PathSyntheticModule
  | ProcessSyntheticModule
  | UrlSyntheticModule

export interface NodeCoreSyntheticModules {
  readonly 'node:buffer': BufferSyntheticModule
  readonly 'node:events': EventsSyntheticModule
  readonly 'node:os': OsSyntheticModule
  readonly 'node:path': PathSyntheticModule
  readonly 'node:process': ProcessSyntheticModule
  readonly 'node:url': UrlSyntheticModule
}

export interface NodeCoreSyntheticModuleDescriptor {
  readonly exportNames: readonly string[]
}

export interface NodeCoreSyntheticModuleBinding<
  Namespace extends NodeCoreSyntheticModule = NodeCoreSyntheticModule,
> {
  readonly descriptor: NodeCoreSyntheticModuleDescriptor
  readonly namespace: Namespace
}

export type NodeCoreSyntheticModuleBindings = Readonly<
  {
    [Specifier in keyof NodeCoreSyntheticModules]: NodeCoreSyntheticModuleBinding<
      NodeCoreSyntheticModules[Specifier]
    >
  }
>

export const createNodeCoreSyntheticModules = (
  options: NodeCoreCompatOptions
): NodeCoreSyntheticModules => {
  const resolvedOptions = resolveNodeCoreCompatOptions(options)
  const modules: NodeCoreSyntheticModules = {
    'node:buffer': createBufferSyntheticModule(),
    'node:events': createEventsSyntheticModule(),
    'node:os': createOsSyntheticModule(resolvedOptions.os, resolvedOptions.virtualRoot),
    'node:path': createPathSyntheticModule(resolvedOptions.process.cwd),
    'node:process': createProcessSyntheticModule(
      resolvedOptions.process,
      resolvedOptions.virtualRoot,
      resolvedOptions.stdio,
      resolvedOptions.maxStdioChunkBytes
    ),
    'node:url': createUrlSyntheticModule({
      appBaseUrl: resolvedOptions.appBaseUrl,
      virtualRoot: resolvedOptions.virtualRoot,
      webStandards: resolvedOptions.webStandards
    })
  }
  return Object.freeze(modules)
}

export const createNodeCoreSyntheticModuleBindings = (
  options: NodeCoreCompatOptions
): NodeCoreSyntheticModuleBindings => {
  const namespaces = createNodeCoreSyntheticModules(options)
  const bindings: Partial<Record<NodeCoreModuleSpecifier, NodeCoreSyntheticModuleBinding>> = {}
  for (const specifier of Object.keys(namespaces) as NodeCoreModuleSpecifier[]) {
    const namespace = namespaces[specifier]
    const exportNames = Object.freeze(Object.keys(namespace))
    bindings[specifier] = Object.freeze({
      descriptor: Object.freeze({ exportNames }),
      namespace
    })
  }
  return Object.freeze(bindings) as NodeCoreSyntheticModuleBindings
}
