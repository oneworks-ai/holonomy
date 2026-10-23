/* eslint-disable max-lines -- one Runtime composition path owns the corresponding cleanup. */

import {
  createUnsupportedCapabilityWebSocketV1,
  createWebAbortConstructors
} from '@holonomyjs/capability-network/web/index'
import { createGitAuthority, createGitFacade } from '../git/index.js'
import { createNodeTestSyntheticModules } from '../node-test/index.js'
import { createStorageAuthority, createStorageFacade } from '../storage/index.js'
import { createRuntimeImmediate } from '../timers/index.js'
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
  'testPromiseBrand',
  'timers'
] as const
const FREEZE = Object.freeze
const KEYS = Object.keys
const APPLY = Reflect.apply

export const createHolonomyRuntime = async (input: HolonomyRuntimeOptions): Promise<HolonomyRuntime> => {
  const options = snapshotRecord(input, TOP, ['authority', 'eventLoop', 'nativePort', 'nodeCore'])
  if (options.testPromiseBrand !== undefined && typeof options.testPromiseBrand !== 'function') {
    throw runtimeComposerError('runtime_composer.invalid_options')
  }
  const root = snapshotRuntimeAuthority(options.authority)
  const factories = getRuntimeComposerFactories()
  const bridgeOptions = options.bridge === undefined ? undefined : snapshotRecord(options.bridge, ['limits'])
  let bridge: ReturnType<(typeof factories)['createNativeBridge']> | undefined
  let fs: ReturnType<(typeof factories)['createNodeFsFacade']> | undefined
  let httpServer: ReturnType<(typeof factories)['createHttpServerRuntime']> | undefined
  let crypto: ReturnType<(typeof factories)['installCryptoRuntime']> | undefined
  let network: ReturnType<(typeof factories)['createFetchRuntime']> | undefined
  let abort: ReturnType<typeof createWebAbortConstructors> | undefined
  let immediate: ReturnType<typeof createRuntimeImmediate> | undefined
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
    abort = createWebAbortConstructors(options.eventLoop as HolonomyRuntimeOptions['eventLoop'])
    if (options.network !== undefined) {
      if (
        !hasCapability(root.capabilities, 'host.network.http') &&
        !hasCapability(root.capabilities, 'host.network.mock')
      ) {
        throw runtimeComposerError('runtime_composer.required_capability')
      }
      const networkOptions = prepareRuntimeNetworkOptions(options.network, root.principal)
      network = factories.createFetchRuntime({
        ...networkOptions,
        constructors: {
          AbortController: networkOptions.constructors?.AbortController ??
            abort.AbortController as unknown as typeof globalThis.AbortController,
          AbortSignal: networkOptions.constructors?.AbortSignal ??
            abort.AbortSignal as unknown as typeof globalThis.AbortSignal
        },
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
    const testModules = createNodeTestSyntheticModules(
      (options.testPlatform ?? 'node') as never,
      options.testPromiseBrand as never
    )
    let disposed = false
    const pendingNextTicks = new Set<number>()
    const eventLoop = options.eventLoop as HolonomyRuntimeOptions['eventLoop']
    if (options.timers != null) immediate = createRuntimeImmediate(eventLoop)
    const syntheticModules = createRuntimeRegistry({
      console: options.console as never,
      crypto,
      fs,
      git,
      httpServer,
      moduleOverrides: options.moduleOverrides as never,
      nodeCore: {
        ...(options.nodeCore as HolonomyRuntimeOptions['nodeCore']),
        nextTick: (callback: (...args: unknown[]) => unknown, ...args: unknown[]) => {
          if (disposed) throw runtimeComposerError('runtime_composer.disposed')
          let taskId: number | undefined
          let completed = false
          const admittedId = eventLoop.enqueueNextTick(() => {
            completed = true
            if (taskId !== undefined) pendingNextTicks.delete(taskId)
            if (!disposed) APPLY(callback, undefined, args)
          })
          taskId = admittedId
          if (!completed) pendingNextTicks.add(admittedId)
        }
      },
      storage,
      testModules,
      timers: options.timers as never,
      immediate
    })
    const networkGlobals: Record<string, object> = network == null
      ? {
        WebSocket: createUnsupportedCapabilityWebSocketV1(),
        AbortController: abort.AbortController,
        AbortSignal: abort.AbortSignal
      }
      : {
        WebSocket: createUnsupportedCapabilityWebSocketV1(),
        AbortController: network.AbortController,
        AbortSignal: network.AbortSignal,
        Headers: network.Headers,
        Request: network.Request,
        Response: network.Response,
        fetch: network.fetch
      }
    const globals = createRuntimeGlobals(
      crypto,
      networkGlobals,
      options.console as never,
      options.timers as never,
      immediate
    ) as unknown as HolonomyRuntime['globals']
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
          for (const taskId of pendingNextTicks) {
            try {
              eventLoop.cancelTask(taskId)
            } catch {
              // A fatal Event Loop failure already clears its queue; continue Runtime cleanup.
              break
            }
          }
          pendingNextTicks.clear()
          immediate?.dispose()
          abort?.dispose()
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
    immediate?.dispose()
    abort?.dispose()
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
