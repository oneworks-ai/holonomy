import { CHILD_PROCESS_CAPABILITY_MATRIX, createChildProcessSyntheticModuleBinding } from '../child-process/index.js'
import { CRYPTO_CAPABILITY_MATRIX } from '../crypto/index.js'
import { GIT_CAPABILITY_MATRIX } from '../git/index.js'
import { HTTP_SERVER_CAPABILITY_MATRIX, createHttpServerSyntheticModuleBindings } from '../http-server/index.js'
import { NODE_CORE_CAPABILITY_MATRIX, createNodeCoreSyntheticModuleBindings } from '../node-compat/index.js'
import { FS_CAPABILITY_MATRIX, createFsSyntheticModules } from '../node-fs/index.js'
import { STORAGE_CAPABILITY_MATRIX } from '../storage/index.js'
import {
  STREAM_CAPABILITY_MATRIX,
  createStreamSyntheticModuleBindings,
  createWebStreamsGlobals
} from '../streams/index.js'
import { WEB_NETWORK_CAPABILITY_MATRIX } from '../web-network/index.js'
import { runtimeComposerError } from './errors.js'
import {
  createRuntimeRecord,
  defineRuntimeData,
  freezeRuntimeValue,
  getRuntimeOwnDescriptor,
  runtimeString,
  withUnshadowedObjectPrototypeKeys
} from './intrinsics.js'

import type { InstalledCryptoRuntime } from '../crypto/index.js'
import type { GitFacade } from '../git/index.js'
import type { HttpServerRuntime } from '../http-server/index.js'
import type { NodeCoreCompatOptions } from '../node-compat/index.js'
import type { NodeFsFacade } from '../node-fs/index.js'
import type { RuntimeSyntheticModuleBinding } from './types.js'

const KEYS = Object.keys
const SYNTHETIC_SPECIFIERS = [
  'node:buffer',
  'node:events',
  'node:os',
  'node:path',
  'node:process',
  'node:stream',
  'node:stream/promises',
  'node:stream/web',
  'node:url'
] as const

const binding = (
  namespace: object,
  names: readonly string[],
  defaultValue?: unknown
): RuntimeSyntheticModuleBinding => {
  const exports: string[] = []
  for (let index = 0; index < names.length; index += 1) defineRuntimeData(exports, runtimeString(index), names[index])
  const target = createRuntimeRecord()
  const keys = KEYS(namespace)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string
    const descriptor = getRuntimeOwnDescriptor(namespace, key)
    if (descriptor == null || !('value' in descriptor)) throw runtimeComposerError('runtime_composer.invalid_options')
    defineRuntimeData(target, key, descriptor.value)
  }
  if (defaultValue !== undefined) {
    defineRuntimeData(exports, runtimeString(exports.length), 'default')
    defineRuntimeData(target, 'default', defaultValue)
  }
  return freezeRuntimeValue({
    descriptor: freezeRuntimeValue({ exportNames: freezeRuntimeValue(exports) }),
    namespace: freezeRuntimeValue(target)
  })
}

const add = (
  target: Record<string, RuntimeSyntheticModuleBinding>,
  source: Record<string, RuntimeSyntheticModuleBinding>
) => {
  const specifiers = KEYS(source)
  for (let index = 0; index < specifiers.length; index += 1) {
    const specifier = specifiers[index] as string
    if (getRuntimeOwnDescriptor(target, specifier) != null) {
      throw runtimeComposerError('runtime_composer.duplicate_module')
    }
    const descriptor = getRuntimeOwnDescriptor(source, specifier)
    if (descriptor == null || !('value' in descriptor)) throw runtimeComposerError('runtime_composer.invalid_options')
    defineRuntimeData(target, specifier, descriptor.value)
  }
}

const createRegistry = (
  input: {
    readonly crypto?: InstalledCryptoRuntime
    readonly fs?: NodeFsFacade
    readonly git?: GitFacade
    readonly httpServer?: HttpServerRuntime
    readonly nodeCore: NodeCoreCompatOptions
  }
) => {
  const modules = createRuntimeRecord() as Record<string, RuntimeSyntheticModuleBinding>
  add(modules, createNodeCoreSyntheticModuleBindings(input.nodeCore))
  add(modules, createStreamSyntheticModuleBindings())
  if (input.fs != null) {
    for (const [specifier, module] of createFsSyntheticModules(input.fs)) {
      const names = KEYS(module.named)
      const source = createRuntimeRecord() as Record<string, RuntimeSyntheticModuleBinding>
      defineRuntimeData(source, specifier, binding(module.named, names, module.default))
      add(modules, source)
    }
  }
  if (input.httpServer != null) add(modules, createHttpServerSyntheticModuleBindings(input.httpServer))
  if (input.crypto != null) {
    const source = createRuntimeRecord() as Record<string, RuntimeSyntheticModuleBinding>
    defineRuntimeData(source, 'node:crypto', input.crypto.createSyntheticModuleBinding())
    add(modules, source)
  }
  if (input.git != null) {
    const source = createRuntimeRecord() as Record<string, RuntimeSyntheticModuleBinding>
    defineRuntimeData(source, 'node:child_process', createChildProcessSyntheticModuleBinding({ git: input.git }))
    add(modules, source)
  }
  return freezeRuntimeValue(modules)
}
export const createRuntimeRegistry = (input: Parameters<typeof createRegistry>[0]) =>
  withUnshadowedObjectPrototypeKeys(SYNTHETIC_SPECIFIERS, () => createRegistry(input))

export const createRuntimeGlobals = (crypto?: InstalledCryptoRuntime, network?: Record<string, object>) => {
  const globals = createRuntimeRecord() as Record<string, object>
  const streams = createWebStreamsGlobals()
  const streamNames = KEYS(streams)
  for (let index = 0; index < streamNames.length; index += 1) {
    const name = streamNames[index] as string
    const descriptor = getRuntimeOwnDescriptor(streams, name)
    if (descriptor == null || !('value' in descriptor)) throw runtimeComposerError('runtime_composer.invalid_options')
    defineRuntimeData(globals, name, descriptor.value)
  }
  if (network != null) {
    const names = KEYS(network)
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index] as string
      const descriptor = getRuntimeOwnDescriptor(network, name)
      if (descriptor == null || !('value' in descriptor)) throw runtimeComposerError('runtime_composer.invalid_options')
      defineRuntimeData(globals, name, descriptor.value)
    }
  }
  if (crypto != null) defineRuntimeData(globals, 'crypto', crypto.installWebCrypto({}) as unknown as object)
  return freezeRuntimeValue(globals)
}

const status = (installed: boolean, matrix: unknown) =>
  freezeRuntimeValue({ installed, matrix, status: installed ? 'installed' : 'unsupported' })
export const createRuntimeCapabilities = (
  input: {
    readonly crypto?: InstalledCryptoRuntime
    readonly fs: boolean
    readonly git: boolean
    readonly httpServer: boolean
    readonly network: boolean
    readonly storage: boolean
  }
) =>
  freezeRuntimeValue({
    'child-process': status(input.git, CHILD_PROCESS_CAPABILITY_MATRIX),
    crypto: input.crypto == null
      ? status(false, CRYPTO_CAPABILITY_MATRIX)
      : freezeRuntimeValue({
        descriptors: input.crypto.capabilityDescriptors,
        installed: true,
        matrix: CRYPTO_CAPABILITY_MATRIX,
        status: 'installed'
      }),
    fs: status(input.fs, FS_CAPABILITY_MATRIX),
    git: status(input.git, GIT_CAPABILITY_MATRIX),
    'http-server': status(input.httpServer, HTTP_SERVER_CAPABILITY_MATRIX),
    network: status(input.network, WEB_NETWORK_CAPABILITY_MATRIX),
    'node-core': status(true, NODE_CORE_CAPABILITY_MATRIX),
    storage: status(input.storage, STORAGE_CAPABILITY_MATRIX),
    streams: status(true, STREAM_CAPABILITY_MATRIX)
  })
