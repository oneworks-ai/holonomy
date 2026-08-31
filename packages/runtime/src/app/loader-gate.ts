import { runtimeComposerError } from './errors.js'

import type { HolonomyModuleLoader } from '../module-loader/index.js'
import type { RuntimeModuleLoader } from './types.js'

const FREEZE = Object.freeze

export const createLoaderGate = (
  loader: HolonomyModuleLoader,
  isDisposed: () => boolean
): RuntimeModuleLoader => {
  const assertLive = () => {
    if (isDisposed()) throw runtimeComposerError('runtime_composer.disposed')
  }
  return FREEZE({
    createPlan: (
      entrySpecifier: Parameters<HolonomyModuleLoader['createPlan']>[0],
      options: Parameters<HolonomyModuleLoader['createPlan']>[1]
    ) => {
      assertLive()
      return loader.createPlan(entrySpecifier, options)
    },
    createRequire: (parentUrl: Parameters<HolonomyModuleLoader['createRequire']>[0]) => {
      assertLive()
      return loader.createRequire(parentUrl)
    },
    limits: loader.limits,
    load: (canonicalUrl: Parameters<HolonomyModuleLoader['load']>[0]) => {
      assertLive()
      return loader.load(canonicalUrl)
    },
    resolve: (
      specifier: Parameters<HolonomyModuleLoader['resolve']>[0],
      parentUrl: Parameters<HolonomyModuleLoader['resolve']>[1],
      mode: Parameters<HolonomyModuleLoader['resolve']>[2]
    ) => {
      assertLive()
      return loader.resolve(specifier, parentUrl, mode)
    },
    resolveResource: (
      specifier: Parameters<HolonomyModuleLoader['resolveResource']>[0],
      parentUrl: Parameters<HolonomyModuleLoader['resolveResource']>[1]
    ) => {
      assertLive()
      return loader.resolveResource(specifier, parentUrl)
    },
    rootUrl: loader.rootUrl
  })
}
