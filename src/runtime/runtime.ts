import { createGitAuthority, createGitFacade } from '../git/index.js'
import { MobileModuleLoader } from '../module-loader/index.js'
import { createStorageAuthority, createStorageFacade } from '../storage/index.js'
import { snapshotGitAuthorityInput, snapshotStorageAuthorityInput } from './authority-snapshot.js'
import { disposeQuietly } from './dispose.js'
import { isRuntimeComposerError, runtimeComposerError } from './errors.js'
import { getRuntimeComposerFactories } from './factories.js'
import {
  createRuntimeRecord,
  defineRuntimeData,
  freezeRuntimeValue,
  hasCapability,
  snapshotOptionalRecord,
  snapshotRecord
} from './intrinsics.js'
import { createLoaderGate } from './loader-gate.js'
import { HTTP_LIMITS, assertChildAuthority, snapshotNetworkAuthority, snapshotRuntimeAuthority } from './options.js'
import { createRuntimeCapabilities, createRuntimeGlobals, createRuntimeRegistry } from './registry.js'

import type { MobileRuntime, MobileRuntimeOptions } from './types.js'

const TOP = [
  'authority',
  'bridge',
  'crypto',
  'eventLoop',
  'fs',
  'git',
  'httpServer',
  'moduleLoader',
  'nativePort',
  'network',
  'nodeCore',
  'storage'
] as const
const FREEZE = Object.freeze
const KEYS = Object.keys

export const createMobileRuntime = async (input: MobileRuntimeOptions): Promise<MobileRuntime> => {
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
      options.nativePort as MobileRuntimeOptions['nativePort'],
      bridgeOptions?.limits === undefined
        ? { authority: root, eventLoop: options.eventLoop as MobileRuntimeOptions['eventLoop'] }
        : {
          authority: root,
          eventLoop: options.eventLoop as MobileRuntimeOptions['eventLoop'],
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
      if (!hasCapability(root.capabilities, 'host.network.http')) {
        throw runtimeComposerError('runtime_composer.required_capability')
      }
      const item = snapshotRecord(options.network, ['authority', 'constructors', 'principal'], [
        'authority',
        'principal'
      ])
      if (item.principal !== root.principal) throw runtimeComposerError('runtime_composer.principal_mismatch')
      const constructors = snapshotOptionalRecord(item.constructors, ['AbortController', 'AbortSignal'])
      network = factories.createFetchRuntime(
        constructors === undefined
          ? { authority: snapshotNetworkAuthority(item.authority) as never, bridge }
          : {
            authority: snapshotNetworkAuthority(item.authority) as never,
            bridge,
            constructors: constructors as never
          }
      )
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
    const syntheticModules = createRuntimeRegistry({ crypto, fs, git, httpServer, nodeCore: options.nodeCore as never })
    const globals = createRuntimeGlobals(
      crypto,
      network == null
        ? undefined
        : {
          AbortController: network.AbortController,
          AbortSignal: network.AbortSignal,
          Headers: network.Headers,
          Request: network.Request,
          Response: network.Response,
          fetch: network.fetch
        }
    ) as unknown as MobileRuntime['globals']
    let disposed = false
    let disposing: Promise<void> | undefined
    const rawLoader = options.moduleLoader === undefined ? undefined : (() => {
      const item = snapshotRecord(options.moduleLoader, [
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
      return new MobileModuleLoader(port, item as never)
    })()
    const moduleLoader = rawLoader == null ? undefined : createLoaderGate(rawLoader, () => disposed)
    const shell: MobileRuntime = {
      bridge,
      capabilities: createRuntimeCapabilities({
        crypto,
        fs: fs != null,
        git: git != null,
        httpServer: httpServer != null,
        network: network != null,
        storage: storage != null
      }),
      crypto,
      eventLoop: options.eventLoop as MobileRuntimeOptions['eventLoop'],
      fs,
      git,
      globals,
      httpServer,
      moduleLoader,
      network,
      storage,
      syntheticModules,
      dispose: () =>
        disposing ??= (async () => {
          if (disposed) return
          disposed = true
          await disposeQuietly(network)
          await disposeQuietly(crypto)
          await disposeQuietly(httpServer)
          await disposeQuietly(fs)
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
    await disposeQuietly(bridge)
    if (isRuntimeComposerError(error)) throw error
    throw runtimeComposerError('runtime_composer.invalid_options')
  }
}
