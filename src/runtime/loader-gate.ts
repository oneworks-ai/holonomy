import { runtimeComposerError } from './errors.js'

import type { MobileModuleLoader } from '../module-loader/index.js'
import type { RuntimeModuleLoader } from './types.js'

const FREEZE = Object.freeze

export const createLoaderGate = (
  loader: MobileModuleLoader,
  isDisposed: () => boolean
): RuntimeModuleLoader => {
  const assertLive = () => {
    if (isDisposed()) throw runtimeComposerError('runtime_composer.disposed')
  }
  return FREEZE({
    createPlan: (
      entrySpecifier: Parameters<MobileModuleLoader['createPlan']>[0],
      options: Parameters<MobileModuleLoader['createPlan']>[1]
    ) => {
      assertLive()
      return loader.createPlan(entrySpecifier, options)
    },
    createRequire: (parentUrl: Parameters<MobileModuleLoader['createRequire']>[0]) => {
      assertLive()
      return loader.createRequire(parentUrl)
    },
    limits: loader.limits,
    load: (canonicalUrl: Parameters<MobileModuleLoader['load']>[0]) => {
      assertLive()
      return loader.load(canonicalUrl)
    },
    resolve: (
      specifier: Parameters<MobileModuleLoader['resolve']>[0],
      parentUrl: Parameters<MobileModuleLoader['resolve']>[1],
      mode: Parameters<MobileModuleLoader['resolve']>[2]
    ) => {
      assertLive()
      return loader.resolve(specifier, parentUrl, mode)
    },
    resolveResource: (
      specifier: Parameters<MobileModuleLoader['resolveResource']>[0],
      parentUrl: Parameters<MobileModuleLoader['resolveResource']>[1]
    ) => {
      assertLive()
      return loader.resolveResource(specifier, parentUrl)
    },
    rootUrl: loader.rootUrl
  })
}
