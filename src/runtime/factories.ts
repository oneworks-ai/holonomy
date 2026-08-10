import { installCryptoRuntime } from '../crypto/index.js'
import { createHttpServerRuntime } from '../http-server/index.js'
import { createNativeBridge } from '../native-port/index.js'
import { createNodeFsFacade } from '../node-fs/index.js'
import { createFetchRuntime } from '../web-network/index.js'

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
