/* eslint-disable max-lines -- Registry assembly remains the single owner of synthetic-module composition order. */

import { createFsSyntheticModules } from '@holonomyjs/capability-fs/node/index'
import { createChildProcessSyntheticModuleBinding } from '@holonomyjs/capability-process/legacy/index'
import { createHttpServerSyntheticModuleBindings } from '../http-server/index.js'
import { createNodeCoreSyntheticModuleBindings } from '../node-compat/index.js'
import { createStreamSyntheticModuleBindings } from '../streams/index.js'
import { runtimeComposerError } from './errors.js'
import {
  createRuntimeRecord,
  defineRuntimeData,
  freezeRuntimeValue,
  getRuntimeOwnDescriptor,
  runtimeString,
  withUnshadowedObjectPrototypeKeys
} from './intrinsics.js'

import type { NodeFsFacade } from '@holonomyjs/capability-fs/node/index'
import type { InstalledCryptoRuntime } from '../crypto/index.js'
import type { GitFacade } from '../git/index.js'
import type { HttpServerRuntime } from '../http-server/index.js'
import type { NodeCoreCompatOptions } from '../node-compat/index.js'
import type { createNodeTestSyntheticModules } from '../node-test/index.js'
import type { InstalledRuntimeConsole } from '../runtime-console/index.js'
import type { RuntimeTimers } from '../timers/index.js'
import type { RuntimeSyntheticModuleBinding } from './types.js'

const KEYS = Object.keys
const SYNTHETIC_SPECIFIERS = [
  'node:buffer',
  'node:assert/strict',
  'node:console',
  'node:events',
  'node:os',
  'node:path',
  'node:process',
  'node:test',
  'node:timers',
  'node:stream',
  'node:stream/promises',
  'node:stream/web',
  'node:url'
] as const
const OVERRIDABLE_SPECIFIERS = new Set([
  'holo:device',
  'holo:device/promises',
  'holo:runtime',
  'node:fs',
  'node:fs/promises',
  'node:child_process',
  'node:os',
  'node:process'
])

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
    const descriptor = getRuntimeOwnDescriptor(target, 'default')
    if (descriptor == null) defineRuntimeData(target, 'default', defaultValue)
    else if (!('value' in descriptor) || descriptor.value !== defaultValue) {
      throw runtimeComposerError('runtime_composer.invalid_options')
    }
  }
  return freezeRuntimeValue({
    descriptor: freezeRuntimeValue({ exportNames: freezeRuntimeValue(exports) }),
    namespace: freezeRuntimeValue(target)
  })
}

const moduleNames = (namespace: object) => {
  const keys = KEYS(namespace)
  const names: string[] = []
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string
    if (key !== 'default') defineRuntimeData(names, runtimeString(names.length), key)
  }
  return names
}

const add = (
  target: Record<string, RuntimeSyntheticModuleBinding>,
  source: Record<string, RuntimeSyntheticModuleBinding>,
  skippedSpecifiers?: ReadonlySet<string>
) => {
  const specifiers = KEYS(source)
  for (let index = 0; index < specifiers.length; index += 1) {
    const specifier = specifiers[index] as string
    if (skippedSpecifiers?.has(specifier) === true) continue
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
    readonly console?: InstalledRuntimeConsole
    readonly fs?: NodeFsFacade
    readonly git?: GitFacade
    readonly httpServer?: HttpServerRuntime
    readonly nodeCore: NodeCoreCompatOptions
    readonly moduleOverrides?: Readonly<Record<string, RuntimeSyntheticModuleBinding>>
    readonly testModules: ReturnType<typeof createNodeTestSyntheticModules>
    readonly timers?: RuntimeTimers
  }
) => {
  const modules = createRuntimeRecord() as Record<string, RuntimeSyntheticModuleBinding>
  const overrideSpecifiers = new Set(input.moduleOverrides == null ? [] : KEYS(input.moduleOverrides))
  add(modules, createNodeCoreSyntheticModuleBindings(input.nodeCore), overrideSpecifiers)
  add(modules, createStreamSyntheticModuleBindings())
  {
    const source = createRuntimeRecord() as Record<string, RuntimeSyntheticModuleBinding>
    defineRuntimeData(
      source,
      'node:assert/strict',
      binding(
        input.testModules['node:assert/strict'],
        moduleNames(input.testModules['node:assert/strict']),
        input.testModules['node:assert/strict'].default
      )
    )
    defineRuntimeData(
      source,
      'node:test',
      binding(
        input.testModules['node:test'],
        moduleNames(input.testModules['node:test']),
        input.testModules['node:test'].default
      )
    )
    add(modules, source)
  }
  if (input.console != null) {
    const source = createRuntimeRecord() as Record<string, RuntimeSyntheticModuleBinding>
    defineRuntimeData(
      source,
      'node:console',
      binding(
        input.console.syntheticModule,
        KEYS(input.console.syntheticModule),
        input.console.syntheticModule.default
      )
    )
    add(modules, source)
  }
  if (input.timers != null) {
    const source = createRuntimeRecord() as Record<string, RuntimeSyntheticModuleBinding>
    defineRuntimeData(source, 'node:timers', binding(input.timers.syntheticModule, KEYS(input.timers.syntheticModule)))
    add(modules, source)
  }
  if (input.fs != null) {
    for (const [specifier, module] of createFsSyntheticModules(input.fs)) {
      const names = KEYS(module.named)
      const source = createRuntimeRecord() as Record<string, RuntimeSyntheticModuleBinding>
      defineRuntimeData(source, specifier, binding(module.named, names, module.default))
      add(modules, source, overrideSpecifiers)
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
    add(modules, source, overrideSpecifiers)
  }
  if (input.moduleOverrides != null) {
    const source = createRuntimeRecord() as Record<string, RuntimeSyntheticModuleBinding>
    for (const specifier of KEYS(input.moduleOverrides)) {
      if (!OVERRIDABLE_SPECIFIERS.has(specifier)) {
        throw runtimeComposerError('runtime_composer.invalid_options')
      }
      const bindingValue = getRuntimeOwnDescriptor(input.moduleOverrides, specifier)
      if (bindingValue == null || !('value' in bindingValue)) {
        throw runtimeComposerError('runtime_composer.invalid_options')
      }
      const value = bindingValue.value as RuntimeSyntheticModuleBinding
      const names = value?.descriptor?.exportNames
      const namespace = value?.namespace
      if (
        !Array.isArray(names) || new Set(names).size !== names.length || names.some(name => typeof name !== 'string')
      ) {
        throw runtimeComposerError('runtime_composer.invalid_options')
      }
      if (namespace == null || (typeof namespace !== 'object' && typeof namespace !== 'function')) {
        throw runtimeComposerError('runtime_composer.invalid_options')
      }
      for (const name of names) {
        const descriptor = getRuntimeOwnDescriptor(namespace, name)
        if (descriptor == null || !('value' in descriptor)) {
          throw runtimeComposerError('runtime_composer.invalid_options')
        }
      }
      defineRuntimeData(
        source,
        specifier,
        freezeRuntimeValue({
          descriptor: freezeRuntimeValue({ exportNames: freezeRuntimeValue([...names]) }),
          namespace
        })
      )
    }
    add(modules, source)
  }
  return freezeRuntimeValue(modules)
}
export const createRuntimeRegistry = (input: Parameters<typeof createRegistry>[0]) =>
  withUnshadowedObjectPrototypeKeys(
    [...SYNTHETIC_SPECIFIERS, ...OVERRIDABLE_SPECIFIERS],
    () => createRegistry(input)
  )
