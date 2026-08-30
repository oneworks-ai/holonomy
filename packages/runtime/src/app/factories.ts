import { createNodeFsFacade } from '@holonomyjs/capability-fs/node/index'
import { createFetchRuntime } from '@holonomyjs/capability-network/web/index'
import { installCryptoRuntime } from '../crypto/index.js'
import { createHttpServerRuntime } from '../http-server/index.js'
import { createNativeBridge } from '../native-port/index.js'

const FREEZE = Object.freeze

const DEFAULT_FACTORIES = FREEZE({
  createFetchRuntime,
  createHttpServerRuntime,
  createNativeBridge,
  createNodeFsFacade,
  installCryptoRuntime
})

export type RuntimeComposerFactories = typeof DEFAULT_FACTORIES
let testFactories: RuntimeComposerFactories | undefined

export const getRuntimeComposerFactories = (): RuntimeComposerFactories => testFactories ?? DEFAULT_FACTORIES

/** Direct internal-test seam; intentionally absent from every package entry point. */
export const setRuntimeComposerFactoriesForTest = (factories: RuntimeComposerFactories) => {
  const previous = testFactories
  testFactories = FREEZE(factories)
  return () => {
    testFactories = previous
  }
}
