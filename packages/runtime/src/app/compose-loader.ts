import { HolonomyModuleLoader } from '../module-loader/index.js'
import { createRuntimeRecord, defineRuntimeData, freezeRuntimeValue, snapshotRecord } from './intrinsics.js'
import { createLoaderGate } from './loader-gate.js'

import type { HolonomyRuntimeOptions, RuntimeSyntheticModuleBinding } from './types.js'

const KEYS = Object.keys

export const composeRuntimeModuleLoader = (
  input: HolonomyRuntimeOptions['moduleLoader'],
  syntheticModules: Readonly<Record<string, RuntimeSyntheticModuleBinding>>,
  isDisposed: () => boolean
) => {
  if (input === undefined) return undefined
  const item = snapshotRecord(input, [
    'allowJsonModules',
    'integrity',
    'limits',
    'readModule',
    'resolutionProfile',
    'rootUrl'
  ], ['readModule', 'rootUrl'])
  const definitions = createRuntimeRecord() as Record<string, { readonly exportNames: readonly string[] }>
  const specifiers = KEYS(syntheticModules)
  for (let index = 0; index < specifiers.length; index += 1) {
    const specifier = specifiers[index] as string
    defineRuntimeData(definitions, specifier, syntheticModules[specifier]!.descriptor)
  }
  const port = freezeRuntimeValue({
    readModule: item.readModule as never,
    syntheticNodeModules: freezeRuntimeValue(definitions)
  })
  return createLoaderGate(new HolonomyModuleLoader(port, item as never), isDisposed)
}
