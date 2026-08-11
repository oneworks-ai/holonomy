import type { CryptoPrimitivePortOptions, InstalledCryptoRuntime } from '../crypto/index.js'
import type { RuntimeEventLoop } from '../event-loop/index.js'
import type { GitAuthorityInput, GitFacade } from '../git/index.js'
import type { HttpServerRuntime, HttpServerRuntimeOptions } from '../http-server/index.js'
import type { HolonomyModuleLoader, HolonomyModuleLoaderOptions } from '../module-loader/index.js'
import type { NativeAuthority, NativeBridge, NativeBridgeOptions, NativePort } from '../native-port/index.js'
import type { NodeCoreCompatOptions } from '../node-compat/index.js'
import type { NodeFsFacade, NodeFsFacadeOptions } from '../node-fs/index.js'
import type { HolonomyTestPlatform } from '../node-test/index.js'
import type { InstalledRuntimeConsole } from '../runtime-console/index.js'
import type { StorageAuthorityInput, StorageFacade } from '../storage/index.js'
import type { RuntimeTimers } from '../timers/index.js'
import type { NetworkAuthority, WebNetworkRuntime, WebNetworkRuntimeOptions } from '../web-network/index.js'

export interface RuntimeSyntheticModuleBinding {
  readonly descriptor: Readonly<{ readonly exportNames: readonly string[] }>
  readonly namespace: object
}

export interface HolonomyRuntimeOptions {
  readonly eventLoop: RuntimeEventLoop
  readonly nativePort: NativePort
  readonly authority: NativeAuthority
  readonly nodeCore: NodeCoreCompatOptions
  readonly console?: InstalledRuntimeConsole
  readonly bridge?: Omit<NativeBridgeOptions, 'authority' | 'eventLoop'>
  readonly fs?: NodeFsFacadeOptions
  readonly httpServer?: Omit<HttpServerRuntimeOptions, 'bridge'>
  readonly crypto?: CryptoPrimitivePortOptions
  readonly git?: GitAuthorityInput
  readonly storage?: StorageAuthorityInput
  readonly testPlatform?: HolonomyTestPlatform
  readonly timers?: RuntimeTimers
  readonly network?: Omit<WebNetworkRuntimeOptions, 'authority' | 'bridge'> & {
    readonly authority: NetworkAuthority
    /** Composer-level identity check; the network leaf itself never accepts a principal. */
    readonly principal: string
  }
  readonly moduleLoader?: Omit<HolonomyModuleLoaderOptions, 'rootUrl'> & {
    readonly rootUrl: string
    readonly readModule: import('../module-loader/index.js').HostModuleLoaderPort['readModule']
  }
}

export interface RuntimeModuleLoader {
  /** Immutable inspection remains available after runtime disposal. */
  readonly limits: HolonomyModuleLoader['limits']
  /** Immutable inspection remains available after runtime disposal. */
  readonly rootUrl: string
  /** All operational methods reject `runtime_composer.disposed` after disposal. */
  createPlan: HolonomyModuleLoader['createPlan']
  createRequire: HolonomyModuleLoader['createRequire']
  load: HolonomyModuleLoader['load']
  resolve: HolonomyModuleLoader['resolve']
  resolveResource: HolonomyModuleLoader['resolveResource']
}

export interface HolonomyRuntimeGlobals {
  readonly AbortController?: object
  readonly AbortSignal?: object
  readonly Headers?: object
  readonly ReadableStream: object
  readonly Request?: object
  readonly Response?: object
  readonly TransformStream: object
  readonly WritableStream: object
  readonly crypto?: object
  readonly console?: object
  readonly fetch?: object
  readonly clearInterval?: object
  readonly clearTimeout?: object
  readonly setInterval?: object
  readonly setTimeout?: object
}

export interface HolonomyRuntimeSnapshot {
  readonly disposed: boolean
  readonly globals: readonly string[]
  readonly modules: readonly string[]
  readonly nativeBridge: ReturnType<NativeBridge['getSnapshot']>
}

export interface HolonomyRuntime {
  readonly bridge: NativeBridge
  readonly capabilities: Readonly<Record<string, unknown>>
  readonly crypto?: InstalledCryptoRuntime
  readonly console?: InstalledRuntimeConsole
  readonly eventLoop: RuntimeEventLoop
  readonly fs?: NodeFsFacade
  readonly git?: GitFacade
  readonly globals: HolonomyRuntimeGlobals
  readonly httpServer?: HttpServerRuntime
  readonly moduleLoader?: RuntimeModuleLoader
  readonly network?: WebNetworkRuntime
  readonly storage?: StorageFacade
  readonly timers?: RuntimeTimers
  readonly syntheticModules: Readonly<Record<string, RuntimeSyntheticModuleBinding>>
  dispose(): Promise<void>
  getSnapshot(): HolonomyRuntimeSnapshot
}
