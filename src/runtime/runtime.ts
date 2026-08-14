import { createGitAuthority, createGitFacade } from '../git/index.js'
import { createNodeTestSyntheticModules } from '../node-test/index.js'
import { createStorageAuthority, createStorageFacade } from '../storage/index.js'
import { DEFAULT_ABORT_CONSTRUCTORS } from '../web-network/index.js'
import { snapshotGitAuthorityInput, snapshotStorageAuthorityInput } from './authority-snapshot.js'
import { composeRuntimeModuleLoader } from './compose-loader.js'
import { disposeQuietly } from './dispose.js'
import { isRuntimeComposerError, runtimeComposerError } from './errors.js'
import { getRuntimeComposerFactories } from './factories.js'
import { hasCapability, snapshotOptionalRecord, snapshotRecord } from './intrinsics.js'
import { prepareRuntimeNetworkOptions } from './network-options.js'
import { HTTP_LIMITS, assertChildAuthority, snapshotRuntimeAuthority } from './options.js'
import { createRuntimeRegistry } from './registry.js'
import { createRuntimeCapabilities, createRuntimeGlobals } from './surface.js'

import type { HolonomyRuntime, HolonomyRuntimeOptions } from './types.js'

const TOP = [
  'authority',
  'bridge',
  'console',
  'crypto',
  'eventLoop',
  'fs',
  'git',
  'httpServer',
  'moduleLoader',
  'moduleOverrides',
  'nativePort',
  'network',
  'nodeCore',
  'storage',
  'testPlatform',
  'timers'
] as const
const FREEZE = Object.freeze
const KEYS = Object.keys

export const createHolonomyRuntime = async (input: HolonomyRuntimeOptions): Promise<HolonomyRuntime> => {
  const options = snapshotRecord(input, TOP, ['authority', 'eventLoop', 'nativePort', 'nodeCore'])
  const root = snapshotRuntimeAuthority(options.authority)
  const factories = getRuntimeComposerFactories()
  const bridgeOptions = options.bridge === undefined ? undefined : snapshotRecord(options.bridge, ['limits'])
  let bridge: ReturnType<(typeof factories)['createNativeBridge']> | undefined
  let fs: ReturnType<(typeof factories)['createNodeFsFacade']> | undefined
  let httpServer: ReturnType<(typeof factories)['createHttpServerRuntime']> | undefined
  let crypto: ReturnType<(typeof factories)['installCryptoRuntime']> | undefined
  let network: ReturnType<(typeof factories)['createFetchRuntime']> | undefined
  try {
    bridge = factories.createNativeBridge(
      options.nativePort as HolonomyRuntimeOptions['nativePort'],
      bridgeOptions?.limits === undefined
        ? { authority: root, eventLoop: options.eventLoop as HolonomyRuntimeOptions['eventLoop'] }
        : {
          authority: root,
          eventLoop: options.eventLoop as HolonomyRuntimeOptions['eventLoop'],
          limits: bridgeOptions.limits as never
        }
    )
    if (options.fs !== undefined) {
      if (!hasCapability(root.capabilities, 'host.fs.v1')) {
        throw runtimeComposerError('runtime_composer.required_capability')
      }
      fs = factories.createNodeFsFacade(bridge, options.fs as never)
    }
    if (options.httpServer !== undefined) {
      if (!hasCapability(root.capabilities, 'http.server')) {
        throw runtimeComposerError('runtime_composer.required_capability')
      }
      const http = snapshotRecord(options.httpServer, ['limits'])
      const limits = snapshotOptionalRecord(http.limits, HTTP_LIMITS)
      httpServer = factories.createHttpServerRuntime(
        limits === undefined ? { bridge } : { bridge, limits: limits as never }
      )
    }
    if (options.crypto !== undefined) crypto = factories.installCryptoRuntime(options.crypto as never)
    if (options.network !== undefined) {
      if (
        !hasCapability(root.capabilities, 'host.network.http') &&
        !hasCapability(root.capabilities, 'host.network.mock')
      ) {
        throw runtimeComposerError('runtime_composer.required_capability')
      }
      network = factories.createFetchRuntime({
        ...prepareRuntimeNetworkOptions(options.network, root.principal),
        bridge
      })
    }
    const gitInput = options.git === undefined ? undefined : snapshotGitAuthorityInput(options.git)
    const storageInput = options.storage === undefined ? undefined : snapshotStorageAuthorityInput(options.storage)
    if (gitInput !== undefined) assertChildAuthority(gitInput, 'host.git.v1', root)
    if (storageInput !== undefined) assertChildAuthority(storageInput, 'host.storage.v1', root)
    const gitAuthority = gitInput === undefined ? undefined : createGitAuthority(gitInput)
    const storageAuthority = options.storage === undefined
      ? undefined
      : createStorageAuthority(storageInput!)
    const git = gitAuthority === undefined ? undefined : createGitFacade({ authority: gitAuthority, bridge })
    const storage = options.storage === undefined
      ? undefined
      : createStorageFacade({ authority: storageAuthority!, bridge })
    const testModules = createNodeTestSyntheticModules((options.testPlatform ?? 'node') as never)
    const syntheticModules = createRuntimeRegistry({
      console: options.console as never,
      crypto,
      fs,
      git,
      httpServer,
      moduleOverrides: options.moduleOverrides as never,
      nodeCore: options.nodeCore as never,
      testModules,
      timers: options.timers as never
    })
    const globals = createRuntimeGlobals(
      crypto,
      network == null
        ? DEFAULT_ABORT_CONSTRUCTORS
        : {
          AbortController: network.AbortController,
          AbortSignal: network.AbortSignal,
          Headers: network.Headers,
          Request: network.Request,
          Response: network.Response,
          fetch: network.fetch
        },
      options.console as never,
      options.timers as never
    ) as unknown as HolonomyRuntime['globals']
    let disposed = false
    let disposing: Promise<void> | undefined
    const moduleLoader = composeRuntimeModuleLoader(
      options.moduleLoader as HolonomyRuntimeOptions['moduleLoader'],
      syntheticModules,
      () => disposed
    )
    const shell: HolonomyRuntime = {
      bridge,
      capabilities: createRuntimeCapabilities({
        console: options.console != null,
        crypto,
        fs: fs != null,
        git: git != null,
        httpServer: httpServer != null,
        network: network != null,
        storage: storage != null,
        timers: options.timers != null
      }),
      crypto,
      console: options.console as never,
      eventLoop: options.eventLoop as HolonomyRuntimeOptions['eventLoop'],
      fs,
      git,
      globals,
      httpServer,
      moduleLoader,
      network,
      storage,
      timers: options.timers as never,
      syntheticModules,
      dispose: () =>
        disposing ??= (async () => {
          if (disposed) return
          disposed = true
          await disposeQuietly(network)
          await disposeQuietly(crypto)
          await disposeQuietly(httpServer)
          await disposeQuietly(fs)
          await disposeQuietly(options.timers as never)
          await disposeQuietly(bridge)
        })(),
      getSnapshot: () =>
        FREEZE({
          disposed,
          globals: FREEZE(KEYS(globals)),
          modules: FREEZE(KEYS(syntheticModules)),
          nativeBridge: bridge!.getSnapshot()
        })
    }
    return FREEZE(shell)
  } catch (error) {
    await disposeQuietly(network)
    await disposeQuietly(crypto)
    await disposeQuietly(httpServer)
    await disposeQuietly(fs)
    await disposeQuietly(options.timers as never)
    await disposeQuietly(bridge)
    if (isRuntimeComposerError(error)) throw error
    throw runtimeComposerError('runtime_composer.invalid_options')
  }
}
